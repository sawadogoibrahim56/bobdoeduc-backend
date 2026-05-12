// ============================================================
// src/quiz/quiz.routes.js — Moteur de quiz BobdoEduc
// ============================================================
'use strict';
const express = require('express');
const crypto  = require('crypto');
const { getDatabase } = require('../config/database');
const jwt     = require('jsonwebtoken');

const router = express.Router();

// ── Auth inline (évite import circulaire) ─────────────────────
async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer '))
      return res.status(401).json({ error: 'Token requis.' });
    const token = header.split(' ')[1];
    let decoded;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
    catch (e) {
      if (e.name === 'TokenExpiredError')
        return res.status(401).json({ error: 'Token expiré.', code: 'TOKEN_EXPIRED' });
      return res.status(401).json({ error: 'Token invalide.' });
    }
    if (decoded.type !== 'access')
      return res.status(401).json({ error: 'Type de token invalide.' });
    const db   = getDatabase();
    const user = await db.findOne('users', { id: decoded.sub });
    if (!user)          return res.status(401).json({ error: 'Utilisateur introuvable.' });
    if (user.is_banned) return res.status(403).json({ error: 'Compte suspendu.' });
    req.user = user;
    next();
  } catch (e) {
    console.error('[quiz/auth]', e.message);
    res.status(500).json({ error: 'Erreur authentification.' });
  }
}

async function quizAccessMiddleware(req, res, next) {
  const user       = req.user;
  const FREE_LIMIT = parseInt(process.env.FREE_QUIZ_LIMIT) || 20;
  const isPremium  = user.plan !== 'free'
    && user.subscription_end
    && new Date(user.subscription_end) > new Date();

  if (isPremium) { req.isPremium = true; return next(); }

  if ((user.quiz_free_used || 0) < FREE_LIMIT) {
    req.isPremium     = false;
    req.freeRemaining = FREE_LIMIT - (user.quiz_free_used || 0);
    return next();
  }

  return res.status(402).json({
    error:   'Quota gratuit épuisé.',
    code:    'PREMIUM_REQUIRED',
    message: `Vous avez utilisé vos ${FREE_LIMIT} quiz gratuits. Passez en Premium pour continuer.`,
    plans: {
      premium_monthly: { price: parseInt(process.env.PREMIUM_MONTHLY_PRICE) || 3000,  label: '3 000 FCFA / mois', duration: '1 mois' },
      premium_yearly:  { price: parseInt(process.env.PREMIUM_YEARLY_PRICE)  || 15000, label: '15 000 FCFA / an',  duration: '1 an'   }
    }
  });
}

router.use(authMiddleware);
router.use(quizAccessMiddleware);

// ── Utilitaires ───────────────────────────────────────────────
const signSess = (sid, uid, cycle) =>
  crypto.createHmac('sha256', process.env.HMAC_SECRET)
    .update(`${sid}:${uid}:${cycle}`).digest('hex');

function shuffleWithMap(options, seed) {
  const arr = options.map((t, i) => ({ t, i }));
  let h = Number(seed) || (typeof seed === 'string' ? seed.charCodeAt(0) * 31 : 42);
  for (let i = arr.length - 1; i > 0; i--) {
    h = (h * 1103515245 + 12345) & 0x7fffffff;
    const j = h % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function shuffleOnly(options, seed) {
  return shuffleWithMap(options, seed).map(o => o.t);
}

// ── POST /api/quiz/start ──────────────────────────────────────
router.post('/start', async (req, res) => {
  const userId = req.user.id;
  try {
    const { cycle } = req.body;
    const validCycles = ['cycle_c', 'cycle_b', 'cycle_a'];
    if (!validCycles.includes(cycle))
      return res.status(400).json({ error: 'Cycle invalide. Valeurs: cycle_c, cycle_b, cycle_a' });

    const db = getDatabase();

    const active = await db.query(
      `SELECT id FROM quiz_sessions WHERE user_id=$1 AND is_active=true LIMIT 1`, [userId]
    );
    if (active[0])
      return res.status(409).json({ error: 'Une session est déjà en cours.', session_id: active[0].id });

    let questions = await db.getUnseenQuestions(userId, cycle, 10);

    if (!questions || questions.length < 5) {
      questions = await db.query(
        `SELECT q.*, c.name AS category_name FROM questions q
         JOIN categories c ON c.id = q.category_id
         WHERE q.cycle = $1 AND q.is_active = true
         ORDER BY RANDOM() LIMIT 10`,
        [cycle]
      );
    }

    if (!questions || questions.length === 0)
      return res.status(503).json({ error: 'Aucune question disponible pour ce cycle.' });

    if (!req.isPremium)
      await db.update('users', { quiz_free_used: (req.user.quiz_free_used || 0) + 1 }, { id: userId });

    const sid  = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const qIds = questions.map(q => q.id);
    const hmac = signSess(sid, userId, cycle);

    await db.insert('quiz_sessions', {
      id: sid, user_id: userId, cycle,
      is_premium_session: req.isPremium ? true : false,
      question_ids: JSON.stringify(qIds),
      hmac_signature: hmac
    });

    const FREE_LIMIT = parseInt(process.env.FREE_QUIZ_LIMIT) || 20;
    const clientQs   = questions.map(q => ({
      id:         q.id,
      category:   q.category_name,
      cycle:      q.cycle,
      difficulty: q.difficulty,
      text:       q.question_text,
      options:    shuffleOnly([q.option_a, q.option_b, q.option_c, q.option_d], q.id)
    }));

    res.json({
      success:        true,
      session_id:     sid,
      cycle,
      n_questions:    clientQs.length,
      is_premium:     req.isPremium,
      free_remaining: req.isPremium ? null : Math.max(0, FREE_LIMIT - (req.user.quiz_free_used || 0) - 1),
      questions:      clientQs
    });

  } catch (e) {
    console.error('[quiz/start]', e.message);
    res.status(500).json({ error: 'Erreur démarrage quiz.' });
  }
});

// ── POST /api/quiz/answer ─────────────────────────────────────
router.post('/answer', async (req, res) => {
  const userId = req.user.id;
  try {
    const { session_id, question_id, answer_index, time_taken_ms } = req.body;
    if (!session_id || question_id === undefined)
      return res.status(400).json({ error: 'Données manquantes.' });

    const db   = getDatabase();
    const rows = await db.query(
      `SELECT * FROM quiz_sessions WHERE id=$1 AND user_id=$2 AND is_active=true LIMIT 1`,
      [session_id, userId]
    );
    const sess = rows[0];
    if (!sess) return res.status(404).json({ error: 'Session introuvable ou déjà terminée.' });

    const expectedHmac = signSess(sess.id, userId, sess.cycle);
    if (sess.hmac_signature !== expectedHmac) {
      await db.insert('audit_logs', {
        user_id: userId, action: 'quiz_tamper_detected', status: 'suspicious',
        ip_address: req.ip, metadata: JSON.stringify({ session_id })
      });
      return res.status(403).json({ error: 'Session compromise détectée.' });
    }

    const qIds = JSON.parse(sess.question_ids || '[]');
    if (!qIds.includes(Number(question_id)))
      return res.status(400).json({ error: 'Question invalide pour cette session.' });

    const already = await db.query(
      `SELECT id FROM quiz_answers WHERE session_id=$1 AND question_id=$2 LIMIT 1`,
      [session_id, question_id]
    );
    if (already[0]) return res.status(409).json({ error: 'Question déjà répondue.' });

    const qRows = await db.query(
      `SELECT q.*, c.name AS category_name FROM questions q
       JOIN categories c ON c.id = q.category_id WHERE q.id=$1 LIMIT 1`,
      [question_id]
    );
    const q = qRows[0];
    if (!q) return res.status(404).json({ error: 'Question introuvable.' });

    const shuffled   = shuffleWithMap([q.option_a, q.option_b, q.option_c, q.option_d], question_id);
    const origIdx    = shuffled[answer_index] ? shuffled[answer_index].i : -1;
    const is_correct = (origIdx === q.correct_answer_index);

    const newScore   = sess.score           + (is_correct ? 1 : -1);
    const newCorrect = sess.correct_count   + (is_correct ? 1 : 0);
    const newWrong   = sess.wrong_count     + (is_correct ? 0 : 1);
    const newIdx     = sess.current_q_index + 1;
    const over       = newIdx >= qIds.length;

    await db.update('quiz_sessions', {
      score: newScore, correct_count: newCorrect, wrong_count: newWrong,
      current_q_index: newIdx, is_active: !over,
      ended_at: over ? new Date().toISOString() : null
    }, { id: session_id });

    await db.insert('quiz_answers', {
      session_id, user_id: userId, question_id,
      user_answer_idx: answer_index, is_correct,
      time_taken_ms: time_taken_ms || null
    });

    await db.query(
      `INSERT INTO user_seen_questions(user_id, question_id, was_correct)
       VALUES($1,$2,$3) ON CONFLICT(user_id, question_id)
       DO UPDATE SET was_correct=$3, seen_at=NOW()`,
      [userId, question_id, is_correct]
    );

    await db.insert('revisions', {
      user_id: userId, question_id, session_id,
      was_correct: is_correct, user_answer_idx: answer_index
    });

    if (over) {
      await db.update('users', {
        total_correct:  (req.user.total_correct  || 0) + newCorrect,
        total_wrong:    (req.user.total_wrong    || 0) + newWrong,
        total_sessions: (req.user.total_sessions || 0) + 1,
        total_score:    (req.user.total_score    || 0) + newScore
      }, { id: userId });
    }

    await db.query(
      `UPDATE questions SET times_answered=times_answered+1, times_correct=times_correct+$1 WHERE id=$2`,
      [is_correct ? 1 : 0, question_id]
    );

    res.json({
      success: true, is_correct,
      correct_option_text: [q.option_a, q.option_b, q.option_c, q.option_d][q.correct_answer_index],
      explanation: q.explanation || null,
      score: newScore, correct_count: newCorrect, wrong_count: newWrong, session_over: over
    });

  } catch (e) {
    console.error('[quiz/answer]', e.message);
    res.status(500).json({ error: 'Erreur traitement réponse.' });
  }
});

// ── POST /api/quiz/quit ───────────────────────────────────────
router.post('/quit', async (req, res) => {
  const userId = req.user.id;
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id requis.' });
    const db   = getDatabase();
    const rows = await db.query(
      `SELECT * FROM quiz_sessions WHERE id=$1 AND user_id=$2 AND is_active=true LIMIT 1`,
      [session_id, userId]
    );
    const sess = rows[0];
    if (!sess) return res.status(404).json({ error: 'Session introuvable.' });
    await db.update('quiz_sessions', { is_active: false, ended_at: new Date().toISOString() }, { id: session_id });
    await db.update('users', { total_sessions: (req.user.total_sessions || 0) + 1 }, { id: userId });
    res.json({ success: true, score: sess.score, correct_count: sess.correct_count, wrong_count: sess.wrong_count });
  } catch (e) {
    console.error('[quiz/quit]', e.message);
    res.status(500).json({ error: 'Erreur fermeture session.' });
  }
});

// ── GET /api/quiz/revisions ───────────────────────────────────
router.get('/revisions', async (req, res) => {
  const userId = req.user.id;
  try {
    const db     = getDatabase();
    const page   = parseInt(req.query.page)  || 1;
    const limit  = Math.min(parseInt(req.query.limit) || 20, 50);
    const offset = (page - 1) * limit;
    const revs   = await db.query(`
      SELECT r.id, r.was_correct, r.user_answer_idx, r.saved_at,
             q.question_text, q.option_a, q.option_b, q.option_c, q.option_d,
             q.correct_answer_index, q.explanation, c.name AS category_name
      FROM revisions r
      JOIN questions  q ON q.id = r.question_id
      JOIN categories c ON c.id = q.category_id
      WHERE r.user_id=$1 ORDER BY r.saved_at DESC LIMIT $2 OFFSET $3
    `, [userId, limit, offset]);
    const opts = ['option_a','option_b','option_c','option_d'];
    res.json({
      revisions: revs.map(r => ({
        id: r.id, was_correct: r.was_correct, saved_at: r.saved_at,
        question: r.question_text, category: r.category_name,
        correct_answer: r[opts[r.correct_answer_index]],
        user_answer: r.user_answer_idx !== null ? r[opts[r.user_answer_idx]] : 'Temps écoulé',
        explanation: r.explanation
      })), page, limit
    });
  } catch (e) {
    console.error('[quiz/revisions]', e.message);
    res.status(500).json({ error: 'Erreur chargement révisions.' });
  }
});

// ── GET /api/quiz/leaderboard ─────────────────────────────────
router.get('/leaderboard', async (req, res) => {
  try {
    const db = getDatabase();
    const lb = await db.query(`
      SELECT id, pseudo, total_score AS points, total_correct, total_sessions,
             CASE WHEN plan != 'free' AND subscription_end > NOW() THEN true ELSE false END AS is_premium
      FROM users WHERE is_banned=false AND is_verified=true
      ORDER BY total_score DESC LIMIT 50
    `, []);
    res.json({ leaderboard: lb, my_id: req.user.id });
  } catch (e) {
    console.error('[quiz/leaderboard]', e.message);
    res.status(500).json({ error: 'Erreur classement.' });
  }
});

module.exports = router;
