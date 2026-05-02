// ============================================================
// src/questions/questions.routes.js â€” Admin BobdoEduc
// AccÃ¨s: X-Admin-Key uniquement
// ============================================================
'use strict';
const express = require('express');
const { getDatabase }    = require('../config/database');
const { adminMiddleware } = require('../guards/auth.middleware');
const router = express.Router();

router.use(adminMiddleware);

// POST /api/questions â€” Ajouter une question
router.post('/', async (req, res) => {
  try {
    const { category_id, cycle, difficulty, question_text,
            option_a, option_b, option_c, option_d,
            correct_answer_index, explanation } = req.body;

    if (!category_id || !cycle || !question_text || correct_answer_index === undefined)
      return res.status(400).json({ error: 'Champs requis: category_id, cycle, question_text, correct_answer_index.' });
    if (![0,1,2,3].includes(Number(correct_answer_index)))
      return res.status(400).json({ error: 'correct_answer_index doit Ãªtre 0, 1, 2 ou 3.' });
    if (!option_a || !option_b || !option_c || !option_d)
      return res.status(400).json({ error: 'Les 4 options sont requises.' });

    const db = getDatabase();
    const q  = await db.insert('questions', {
      category_id, cycle,
      difficulty: difficulty || 1,
      question_text, option_a, option_b, option_c, option_d,
      correct_answer_index: Number(correct_answer_index),
      explanation: explanation || null
    });
    res.status(201).json({ success: true, id: q.id });
  } catch (e) {
    console.error('[questions/post]', e.message);
    res.status(500).json({ error: 'Erreur ajout question.' });
  }
});

// POST /api/questions/bulk â€” Ajout en masse (max 100)
router.post('/bulk', async (req, res) => {
  try {
    const { questions } = req.body;
    if (!Array.isArray(questions) || !questions.length)
      return res.status(400).json({ error: 'Tableau questions requis.' });
    if (questions.length > 100)
      return res.status(400).json({ error: 'Maximum 100 questions par lot.' });

    const db  = getDatabase();
    const ids = [];
    for (const q of questions) {
      const r = await db.insert('questions', q);
      ids.push(r.id);
    }
    res.status(201).json({ success: true, count: ids.length, ids });
  } catch (e) {
    console.error('[questions/bulk]', e.message);
    res.status(500).json({ error: 'Erreur ajout en masse.' });
  }
});

// GET /api/questions/stats â€” Statistiques
router.get('/stats', async (req, res) => {
  try {
    const db   = getDatabase();
    const rows = await db.query(
      `SELECT cycle, COUNT(*) as cnt FROM questions WHERE is_active=true GROUP BY cycle`, []
    );
    const stats = { cycle_c: 0, cycle_b: 0, cycle_a: 0 };
    rows.forEach(r => { if (stats[r.cycle] !== undefined) stats[r.cycle] = parseInt(r.cnt); });
    res.json({ stats, total: Object.values(stats).reduce((a,b) => a+b, 0) });
  } catch (e) {
    console.error('[questions/stats]', e.message);
    res.status(500).json({ error: 'Erreur stats.' });
  }
});

// DELETE /api/questions/:id â€” DÃ©sactiver une question
router.delete('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    await db.update('questions', { is_active: false }, { id: req.params.id });
    res.json({ success: true, message: 'Question dÃ©sactivÃ©e.' });
  } catch (e) {
    console.error('[questions/delete]', e.message);
    res.status(500).json({ error: 'Erreur dÃ©sactivation.' });
  }
});

module.exports = router;
           
