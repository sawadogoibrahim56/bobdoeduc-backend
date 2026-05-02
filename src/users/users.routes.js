// ============================================================
// src/users/users.routes.js â€” Profil BobdoEduc
// ============================================================
'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { getDatabase }    = require('../config/database');
const { authMiddleware } = require('../guards/auth.middleware');
const router = express.Router();

router.use(authMiddleware);

// GET /api/users/me
router.get('/me', async (req, res) => {
  try {
    const db   = getDatabase();
    const user = await db.findOne('users', { id: req.user.id });
    if (!user) return res.status(404).json({ error: 'Utilisateur introuvable.' });
    const FREE   = parseInt(process.env.FREE_QUIZ_LIMIT) || 20;
    const isPrem = user.plan !== 'free' && user.subscription_end && new Date(user.subscription_end) > new Date();
    res.json({
      user: {
        id:                  user.id,
        pseudo:              user.pseudo,
        plan:                user.plan,
        is_premium:          isPrem,
        subscription_end:    user.subscription_end || null,
        quiz_free_used:      user.quiz_free_used      || 0,
        quiz_free_remaining: Math.max(0, FREE - (user.quiz_free_used || 0)),
        total_correct:       user.total_correct   || 0,
        total_wrong:         user.total_wrong     || 0,
        total_sessions:      user.total_sessions  || 0,
        total_score:         user.total_score     || 0
      }
    });
  } catch (e) {
    console.error('[users/me]', e.message);
    res.status(500).json({ error: 'Erreur.' });
  }
});

// PATCH /api/users/pseudo
router.patch('/pseudo', async (req, res) => {
  try {
    const { pseudo } = req.body;
    if (!pseudo || pseudo.length < 2 || pseudo.length > 30)
      return res.status(400).json({ error: 'Pseudo entre 2 et 30 caractÃ¨res.' });
    const db = getDatabase();
    const ex = await db.findOne('users', { pseudo });
    if (ex && ex.id !== req.user.id)
      return res.status(409).json({ error: 'Pseudo dÃ©jÃ  pris.' });
    await db.update('users', { pseudo }, { id: req.user.id });
    res.json({ success: true, pseudo });
  } catch (e) {
    console.error('[users/pseudo]', e.message);
    res.status(500).json({ error: 'Erreur.' });
  }
});

// PATCH /api/users/password
router.patch('/password', async (req, res) => {
  try {
    const { old_password, new_password } = req.body;
    if (!old_password || !new_password || new_password.length < 8)
      return res.status(400).json({ error: 'DonnÃ©es invalides. Nouveau mot de passe min 8 caractÃ¨res.' });
    const db   = getDatabase();
    const user = await db.findOne('users', { id: req.user.id });
    if (!await bcrypt.compare(old_password, user.password_hash))
      return res.status(401).json({ error: 'Ancien mot de passe incorrect.' });
    const hash = await bcrypt.hash(new_password, parseInt(process.env.BCRYPT_ROUNDS_PASSWORD) || 12);
    await db.update('users', { password_hash: hash }, { id: req.user.id });
    await db.query(`UPDATE refresh_tokens SET is_revoked=true WHERE user_id=$1`, [req.user.id]);
    res.json({ success: true, message: 'Mot de passe modifiÃ©. Reconnectez-vous.' });
  } catch (e) {
    console.error('[users/password]', e.message);
    res.status(500).json({ error: 'Erreur.' });
  }
});

module.exports = router;
                          
