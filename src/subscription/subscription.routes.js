// ============================================================
// src/subscription/subscription.routes.js — BOBDOEDUC VERSION B
// Activation MANUELLE — l'admin vérifie et active manuellement
// ============================================================
const express = require('express');
const crypto  = require('crypto');
const { getDatabase } = require('../config/database');
const { authMiddleware } = require('../guards/auth.middleware');
const {
  sendEmail, templateDemandeAdmin,
  templateConfirmUser, templateActivated, templateRejected
} = require('../config/mailer');

const router = express.Router();

const PLANS = {
  premium_monthly: { price:3000,  label:'Premium Mensuel',  days:30  },
  premium_yearly:  { price:15000, label:'Premium Annuel',   days:365 }
};

function isPremiumActive(user) {
  return user?.plan !== 'free'
    && user?.subscription_end
    && new Date(user.subscription_end) > new Date();
}

// ── GET /api/subscription/status ─────────────────────────────
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const db   = getDatabase();
    const user = await db.findOne('users', { id:req.user.id });
    const FREE = parseInt(process.env.FREE_QUIZ_LIMIT)||20;
    const prem = isPremiumActive(user);
    const daysLeft = prem && user.subscription_end
      ? Math.ceil((new Date(user.subscription_end)-new Date())/86400000) : null;

    // Dernière demande en attente
    const pending = await db.query(
      `SELECT id, plan, declared_amount, status, created_at FROM subscription_requests WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
      [req.user.id]
    );
    const history = await db.findMany('subscriptions', { user_id:req.user.id },
      { orderBy:'created_at', order:'DESC', limit:5 });

    res.json({
      plan: user.plan, is_premium: prem,
      subscription_end: user.subscription_end || null, days_left: daysLeft,
      quiz_free_used:     user.quiz_free_used||0,
      quiz_free_remaining:Math.max(0, FREE-(user.quiz_free_used||0)),
      free_limit: FREE,
      latest_request: pending[0] || null,
      plans: {
        premium_monthly: { price:3000,  label:'3 000 FCFA / mois', duration:'1 mois' },
        premium_yearly:  { price:15000, label:'15 000 FCFA / an',  duration:'1 an'   }
      },
      history: history.map(s=>({ plan:s.plan, amount:s.amount, status:s.status, expires_at:s.expires_at }))
    });
  } catch(e) { console.error(e); res.status(500).json({ error:'Erreur.' }); }
});

// ── POST /api/subscription/request ───────────────────────────
// User soumet sa preuve de paiement manuel
router.post('/request', authMiddleware, async (req, res) => {
  try {
    const { plan, declared_amount, payment_phone, payment_operator, notes } = req.body;

    if (!PLANS[plan])
      return res.status(400).json({ error:'Plan invalide. Valeurs: premium_monthly, premium_yearly' });
    if (!payment_phone || payment_phone.replace(/\D/g,'').length < 8)
      return res.status(400).json({ error:'Numéro Mobile Money invalide.' });
    if (!payment_operator)
      return res.status(400).json({ error:'Opérateur requis.' });
    if (!declared_amount || parseInt(declared_amount) < PLANS[plan].price)
      return res.status(400).json({ error:`Montant minimum: ${PLANS[plan].price} FCFA pour ce plan.` });

    const db = getDatabase();

    // Vérifier demande déjà en attente
    const existPending = await db.query(
      `SELECT id FROM subscription_requests WHERE user_id=$1 AND status='pending' LIMIT 1`,
      [req.user.id]
    );
    if (existPending.length > 0)
      return res.status(409).json({
        error:'Une demande est déjà en attente de validation. Attendez la réponse de l\'admin.',
        request_id: existPending[0].id
      });

    // Calculer les dates d'abonnement prévues
    const freshUser  = await db.findOne('users', { id:req.user.id });
    const base       = isPremiumActive(freshUser) && freshUser.subscription_end
      ? new Date(freshUser.subscription_end) : new Date();
    const planned_starts_at  = new Date(base).toISOString();
    const planned_expires_at = (() => { const d=new Date(base); d.setDate(d.getDate()+PLANS[plan].days); return d.toISOString(); })();

    // Générer token admin sécurisé (pour les liens dans l'email)
    const adminToken     = crypto.randomBytes(32).toString('hex');
    const adminTokenHash = crypto.createHash('sha256').update(adminToken).digest('hex');

    const reqId = crypto.randomBytes(16).toString('hex');

    await db.insert('subscription_requests', {
      id:               reqId,
      user_id:          req.user.id,
      plan,
      declared_amount:  parseInt(declared_amount),
      payment_phone:    payment_phone.replace(/\s/g,''),
      payment_operator,
      notes:            notes?.slice(0,300) || null,
      status:           'pending',
      admin_token_hash: adminTokenHash,
      token_expires_at: new Date(Date.now() + 72*60*60*1000).toISOString(),
      planned_starts_at,
      planned_expires_at,
      ip_address: req.ip
    });

    // URL rapide dans l'email (cliquable)
    const BASE = process.env.BACKEND_URL || `http://localhost:${process.env.PORT||4000}`;
    const activationUrl = `${BASE}/api/admin/subscription/quick-action?token=${adminToken}&request_id=${reqId}`;

    // Email à l'admin
    const adminEmailResult = await sendEmail({
      to: process.env.ADMIN_EMAIL,
      ...templateDemandeAdmin({
        requestId:       reqId,
        pseudo:          req.user.pseudo,
        phone:           freshUser.phone_display || '—',
        plan,
        amount:          parseInt(declared_amount),
        paymentPhone:    payment_phone.replace(/\s/g,''),
        paymentOperator: payment_operator,
        notes,
        activationUrl
      })
    });

    if (!adminEmailResult.success)
      console.warn('[sub/request] Email admin non envoyé:', adminEmailResult.error);

    res.json({
      success:     true,
      request_id:  reqId,
      status:      'pending',
      message:     'Demande soumise avec succès ! L\'admin sera notifié et activera votre compte dans les 24h.',
      plan,
      declared_amount: parseInt(declared_amount),
      planned_expires_at
    });

  } catch(e) {
    console.error('[sub/request]', e);
    res.status(500).json({ error:'Erreur soumission de la demande.' });
  }
});

// ── POST /api/subscription/cancel ────────────────────────────
router.post('/cancel', authMiddleware, async (req, res) => {
  try {
    const db   = getDatabase();
    const user = await db.findOne('users', { id:req.user.id });
    if (!isPremiumActive(user)) return res.status(400).json({ error:'Aucun abonnement actif.' });
    await db.query(
      `UPDATE subscriptions SET cancelled_at=NOW(), cancel_reason=$1 WHERE user_id=$2 AND status='active'`,
      [req.body.reason||'user_request', req.user.id]
    );
    res.json({ success:true, message:`Accès maintenu jusqu'au ${new Date(user.subscription_end).toLocaleDateString('fr-FR')}.` });
  } catch(e) { res.status(500).json({ error:'Erreur.' }); }
});

// ── Expiration automatique ────────────────────────────────────
async function expireSubscriptions() {
  try {
    const db = getDatabase();
    const expired = await db.query(
      `SELECT id FROM users WHERE plan!='free' AND subscription_end IS NOT NULL AND subscription_end < NOW()`, []
    );
    for (const u of expired) {
      await db.update('users', { plan:'free' }, { id:u.id });
      await db.query(
        `UPDATE subscriptions SET status='expired' WHERE user_id=$1 AND status='active' AND expires_at < NOW()`,
        [u.id]
      );
    }
    if (expired.length) console.log(`⏰ ${expired.length} abonnement(s) expiré(s) traité(s)`);
  } catch(e) { console.error('[expire]', e); }
}
module.exports = router;
module.exports.expireSubscriptions = expireSubscriptions;

if (process.env.NODE_ENV === 'production') {
  setInterval(expireSubscriptions, 60*60*1000); // toutes les heures
      }
        
