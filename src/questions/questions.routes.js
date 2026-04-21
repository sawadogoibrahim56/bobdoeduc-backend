// ============================================================
// src/questions/questions.routes.js — Admin BobdoEduc
// Accès: X-Admin-Key uniquement
// ============================================================
const express = require('express');
const { getDatabase } = require('../config/database');
const { adminMiddleware } = require('../guards/auth.middleware');
const router = express.Router();
router.use(adminMiddleware);

// POST /api/questions — Ajouter une question
router.post('/', async (req, res) => {
  try {
    const { category_id,cycle,difficulty,question_text,option_a,option_b,option_c,option_d,correct_answer_index,explanation } = req.body;
    if(!category_id||!cycle||!question_text||correct_answer_index===undefined) return res.status(400).json({ error:'Champs requis manquants.' });
    if(![0,1,2,3].includes(correct_answer_index)) return res.status(400).json({ error:'correct_answer_index: 0,1,2 ou 3.' });
    const db = getDatabase();
    const q = await db.insert('questions',{category_id,cycle,difficulty:difficulty||1,question_text,option_a,option_b,option_c,option_d,correct_answer_index,explanation});
    res.status(201).json({ success:true, id:q.id });
  } catch(e) { res.status(500).json({ error:'Erreur ajout question.' }); }
});

// POST /api/questions/bulk — Ajout en masse
router.post('/bulk', async (req, res) => {
  try {
    const { questions } = req.body;
    if(!Array.isArray(questions)||!questions.length) return res.status(400).json({ error:'Tableau requis.' });
    if(questions.length>100) return res.status(400).json({ error:'Max 100 questions par lot.' });
    const db = getDatabase();
    const ids = [];
    for(const q of questions){ const r=await db.insert('questions',q); ids.push(r.id); }
    res.status(201).json({ success:true, count:ids.length, ids });
  } catch(e) { res.status(500).json({ error:'Erreur bulk.' }); }
});

// GET /api/questions/stats
router.get('/stats', async (req, res) => {
  try {
    const db = getDatabase();
    const rows = await db.query(`SELECT cycle, COUNT(*) as cnt FROM questions WHERE is_active=true GROUP BY cycle`,[]);
    const stats={cycle_c:0,cycle_b:0,cycle_a:0};
    rows.forEach(r=>{ if(stats[r.cycle]!==undefined) stats[r.cycle]=parseInt(r.cnt); });
    res.json({ stats, total:Object.values(stats).reduce((a,b)=>a+b,0) });
  } catch(e) { res.status(500).json({ error:'Erreur stats.' }); }
});

// DELETE /api/questions/:id — Désactiver
router.delete('/:id', async (req, res) => {
  try {
    const db = getDatabase();
    await db.update('questions',{is_active:false},{id:req.params.id});
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Erreur.' }); }
});

module.exports = router;
