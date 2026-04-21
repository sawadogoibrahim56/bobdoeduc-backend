// ============================================================
// src/admin/admin.routes.js — Panel Admin BobdoEduc Version B
// ============================================================
// Routes protégées par X-Admin-Key (header)
// Permet de:
//   - Voir toutes les demandes d'abonnement
//   - Activer / Rejeter une demande
//   - Activer via lien email (token signé)
// ============================================================
const express = require('express');
const crypto  = require('crypto');
const { getDatabase } = require('../config/database');
const { adminMiddleware } = require('../guards/auth.middleware');
const {
  sendEmail, templateActivated, templateRejected
} = require('../config/mailer');

const router = express.Router();

const PLANS = {
  premium_monthly: { price:3000,  days:30  },
  premium_yearly:  { price:15000, days:365 }
};

// ── Utilitaire: activer un abonnement ────────────────────────
async function activateSubscription(db, request) {
  const now        = new Date();
  const starts_at  = new Date(request.planned_starts_at || now);
  const expires_at = new Date(request.planned_expires_at || (() => {
    const d = new Date(now);
    d.setDate(d.getDate() + (PLANS[request.plan]?.days || 30));
    return d;
  })());

  // 1. Mettre à jour le user
  await db.update('users', {
    plan:               request.plan,
    subscription_start: starts_at.toISOString(),
    subscription_end:   expires_at.toISOString(),
    subscription_ref:   request.id
  }, { id:request.user_id });

  // 2. Créer l'entrée dans subscriptions
  await db.insert('subscriptions', {
    id:         crypto.randomBytes(16).toString('hex'),
    user_id:    request.user_id,
    plan:       request.plan,
    amount:     request.declared_amount,
    operator:   request.payment_operator,
    phone:      request.payment_phone,
    external_ref: `MANUAL-${request.id.slice(0,8)}`,
    status:     'active',
    starts_at:  starts_at.toISOString(),
    expires_at: expires_at.toISOString()
  });

  // 3. Marquer la demande comme approuvée
  await db.update('subscription_requests', {
    status:       'approved',
    reviewed_at:  new Date().toISOString(),
    activated_at: new Date().toISOString()
  }, { id:request.id });

  return { starts_at, expires_at };
}

// ── GET /api/admin/subscription/quick-action ─────────────────
// Lien cliquable dans l'email — pas besoin de panel, juste un clic
// ?token=xxx&request_id=yyy&action=approve|reject
router.get('/subscription/quick-action', async (req, res) => {
  const { token, request_id, action } = req.query;

  if (!token || !request_id || !['approve','reject'].includes(action)) {
    return res.status(400).send(htmlPage('Lien invalide', '❌ Paramètres manquants ou incorrects.', '#E53935'));
  }

  try {
    const db = getDatabase();
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const requests = await db.query(
      `SELECT * FROM subscription_requests WHERE id=$1 AND admin_token_hash=$2 LIMIT 1`,
      [request_id, tokenHash]
    );
    const req2 = requests[0];

    if (!req2)
      return res.status(404).send(htmlPage('Non trouvé', '❌ Demande introuvable ou lien invalide.', '#E53935'));

    if (req2.status !== 'pending')
      return res.status(400).send(htmlPage('Déjà traitée',
        `ℹ️ Cette demande a déjà été <strong>${req2.status === 'approved' ? 'approuvée ✅' : 'rejetée ❌'}</strong>.`, '#1A73E8'));

    if (new Date(req2.token_expires_at) < new Date())
      return res.status(410).send(htmlPage('Lien expiré', '⏰ Ce lien a expiré (validité 72h). Utilisez le panel admin.', '#E8B923'));

    const user = await db.findOne('users', { id:req2.user_id });

    if (action === 'approve') {
      const { expires_at } = await activateSubscription(db, req2);

      // Email de confirmation à l'utilisateur
      if (user?.email) {
        await sendEmail({
          to: user.email,
          ...templateActivated({ pseudo:user.pseudo, plan:req2.plan, expiresAt:expires_at })
        });
      }

      return res.send(htmlPage('Abonnement activé ✅',
        `✅ L'abonnement <strong>${req2.plan}</strong> de <strong>${user?.pseudo}</strong> a été activé jusqu'au <strong>${expires_at.toLocaleDateString('fr-FR')}</strong>.`,
        '#00A854'
      ));

    } else {
      await db.update('subscription_requests', {
        status:'rejected', reviewed_at:new Date().toISOString(),
        reject_reason: 'Rejet via lien email'
      }, { id:req2.id });

      if (user?.email) {
        await sendEmail({
          to: user.email,
          ...templateRejected({ pseudo:user.pseudo, reason:'Paiement non confirmé' })
        });
      }

      return res.send(htmlPage('Demande rejetée',
        `❌ La demande de <strong>${user?.pseudo}</strong> a été rejetée.`, '#E53935'));
    }

  } catch(e) {
    console.error('[admin/quick-action]', e);
    return res.status(500).send(htmlPage('Erreur', '❌ Erreur serveur: '+e.message, '#E53935'));
  }
});

// ── GET /api/admin/requests ───────────────────────────────────
// Lister toutes les demandes (pour le panel admin)
router.get('/requests', adminMiddleware, async (req, res) => {
  try {
    const db     = getDatabase();
    const status = req.query.status || 'pending'; // pending|approved|rejected|all
    const page   = parseInt(req.query.page)||1;
    const limit  = 20;
    const offset = (page-1)*limit;

    let sql = `
      SELECT sr.*, u.pseudo, u.phone_hash
      FROM subscription_requests sr
      JOIN users u ON u.id = sr.user_id
      ${status !== 'all' ? 'WHERE sr.status=$1' : ''}
      ORDER BY sr.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`;

    const rows = status !== 'all'
      ? await db.query(sql, [status])
      : await db.query(sql, []);

    const total = await db.query(
      `SELECT COUNT(*) as cnt FROM subscription_requests ${status!=='all'?'WHERE status=$1':''}`,
      status!=='all' ? [status] : []
    );

    res.json({ requests:rows, total:parseInt(total[0]?.cnt||0), page, limit });
  } catch(e) { res.status(500).json({ error:'Erreur.' }); }
});

// ── POST /api/admin/requests/:id/approve ─────────────────────
router.post('/requests/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const db = getDatabase();
    const requests = await db.query(
      `SELECT * FROM subscription_requests WHERE id=$1 LIMIT 1`, [req.params.id]
    );
    const request = requests[0];
    if (!request) return res.status(404).json({ error:'Demande introuvable.' });
    if (request.status !== 'pending')
      return res.status(400).json({ error:`Demande déjà ${request.status}.` });

    const { expires_at } = await activateSubscription(db, request);
    const user = await db.findOne('users', { id:request.user_id });

    if (user?.email) {
      await sendEmail({
        to: user.email,
        ...templateActivated({ pseudo:user.pseudo, plan:request.plan, expiresAt:expires_at })
      });
    }

    res.json({
      success:     true,
      message:     `Abonnement ${request.plan} activé pour ${user?.pseudo}`,
      expires_at:  expires_at.toISOString(),
      user_pseudo: user?.pseudo
    });
  } catch(e) { res.status(500).json({ error:'Erreur activation.' }); }
});

// ── POST /api/admin/requests/:id/reject ──────────────────────
router.post('/requests/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const db = getDatabase();
    const requests = await db.query(
      `SELECT * FROM subscription_requests WHERE id=$1 LIMIT 1`, [req.params.id]
    );
    const request = requests[0];
    if (!request) return res.status(404).json({ error:'Demande introuvable.' });
    if (request.status !== 'pending')
      return res.status(400).json({ error:`Déjà ${request.status}.` });

    const { reason } = req.body;
    await db.update('subscription_requests', {
      status:'rejected',
      reviewed_at:   new Date().toISOString(),
      reject_reason: reason || 'Rejet admin'
    }, { id:request.id });

    const user = await db.findOne('users', { id:request.user_id });
    if (user?.email) {
      await sendEmail({
        to: user.email,
        ...templateRejected({ pseudo:user.pseudo, reason })
      });
    }

    res.json({ success:true, message:`Demande rejetée pour ${user?.pseudo}` });
  } catch(e) { res.status(500).json({ error:'Erreur rejet.' }); }
});

// ── GET /api/admin/stats ──────────────────────────────────────
router.get('/stats', adminMiddleware, async (req, res) => {
  try {
    const db = getDatabase();
    const [pending, approved, rejected, total_premium, total_users] = await Promise.all([
      db.query(`SELECT COUNT(*) as c FROM subscription_requests WHERE status='pending'`,[]),
      db.query(`SELECT COUNT(*) as c FROM subscription_requests WHERE status='approved'`,[]),
      db.query(`SELECT COUNT(*) as c FROM subscription_requests WHERE status='rejected'`,[]),
      db.query(`SELECT COUNT(*) as c FROM users WHERE plan!='free' AND subscription_end > NOW()`,[]),
      db.query(`SELECT COUNT(*) as c FROM users WHERE is_banned=false`,[])
    ]);
    res.json({
      pending:       parseInt(pending[0]?.c||0),
      approved:      parseInt(approved[0]?.c||0),
      rejected:      parseInt(rejected[0]?.c||0),
      total_premium: parseInt(total_premium[0]?.c||0),
      total_users:   parseInt(total_users[0]?.c||0)
    });
  } catch(e) { res.status(500).json({ error:'Erreur stats.' }); }
});

// ── Utilitaire: page HTML simple pour les liens email ─────────
function htmlPage(title, message, color='#1A73E8') {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>${title}</title>
  <style>body{font-family:Arial,sans-serif;background:#f4f4f4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{background:white;border-radius:12px;padding:40px;max-width:480px;width:90%;text-align:center;border-top:4px solid ${color}}
  h2{color:${color};margin-top:0}p{color:#444;line-height:1.6}
  a{display:inline-block;margin-top:20px;background:${color};color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold}
  </style></head>
  <body><div class="box"><h2>${title}</h2><p>${message}</p><a href="javascript:history.back()">← Retour</a></div></body></html>`;
}

module.exports = router;
