// ============================================================
// src/admin/admin.routes.js â€” Panel Admin BobdoEduc Version B
// ============================================================
// Routes protÃ©gÃ©es par X-Admin-Key (header)
// Permet de:
//   - Voir toutes les demandes d'abonnement
//   - Activer / Rejeter une demande
//   - Activer via lien email (token signÃ©)
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

// â”€â”€ Utilitaire: activer un abonnement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function activateSubscription(db, request) {
  const now        = new Date();
  const starts_at  = new Date(request.planned_starts_at || now);
  const expires_at = new Date(request.planned_expires_at || (() => {
    const d = new Date(now);
    d.setDate(d.getDate() + (PLANS[request.plan]?.days || 30));
    return d;
  })());

  // 1. Mettre Ã  jour le user
  await db.update('users', {
    plan:               request.plan,
    subscription_start: starts_at.toISOString(),
    subscription_end:   expires_at.toISOString(),
    subscription_ref:   request.id
  }, { id:request.user_id });

  // 2. CrÃ©er l'entrÃ©e dans subscriptions
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

  // 3. Marquer la demande comme approuvÃ©e
  await db.update('subscription_requests', {
    status:       'approved',
    reviewed_at:  new Date().toISOString(),
    activated_at: new Date().toISOString()
  }, { id:request.id });

  return { starts_at, expires_at };
}

// â”€â”€ GET /api/admin/subscription/quick-action â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Lien cliquable dans l'email â€” pas besoin de panel, juste un clic
// ?token=xxx&request_id=yyy&action=approve|reject
router.get('/subscription/quick-action', async (req, res) => {
  const { token, request_id, action } = req.query;

  if (!token || !request_id || !['approve','reject'].includes(action)) {
    return res.status(400).send(htmlPage('Lien invalide', 'âŒ ParamÃ¨tres manquants ou incorrects.', '#E53935'));
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
      return res.status(404).send(htmlPage('Non trouvÃ©', 'âŒ Demande introuvable ou lien invalide.', '#E53935'));

    if (req2.status !== 'pending')
      return res.status(400).send(htmlPage('DÃ©jÃ  traitÃ©e',
        `â„¹ï¸ Cette demande a dÃ©jÃ  Ã©tÃ© <strong>${req2.status === 'approved' ? 'approuvÃ©e âœ…' : 'rejetÃ©e âŒ'}</strong>.`, '#1A73E8'));

    if (new Date(req2.token_expires_at) < new Date())
      return res.status(410).send(htmlPage('Lien expirÃ©', 'â° Ce lien a expirÃ© (validitÃ© 72h). Utilisez le panel admin.', '#E8B923'));

    const user = await db.findOne('users', { id:req2.user_id });

    if (action === 'approve') {
      const { expires_at } = await activateSubscription(db, req2);

      // Email de confirmation Ã  l'utilisateur
      // Note: email chiffrÃ© - notification envoyÃ©e Ã  l'admin uniquement
      console.log(`[admin] Abonnement activÃ© pour ${user?.pseudo}`);

      return res.send(htmlPage('Abonnement activÃ© âœ…',
        `âœ… L'abonnement <strong>${req2.plan}</strong> de <strong>${user?.pseudo}</strong> a Ã©tÃ© activÃ© jusqu'au <strong>${expires_at.toLocaleDateString('fr-FR')}</strong>.`,
        '#00A854'
      ));

    } else {
      await db.update('subscription_requests', {
        status:'rejected', reviewed_at:new Date().toISOString(),
        reject_reason: 'Rejet via lien email'
      }, { id:req2.id });

      console.log(`[admin] Demande rejetÃ©e pour ${user?.pseudo}`);

      return res.send(htmlPage('Demande rejetÃ©e',
        `âŒ La demande de <strong>${user?.pseudo}</strong> a Ã©tÃ© rejetÃ©e.`, '#E53935'));
    }

  } catch(e) {
    console.error('[admin/quick-action]', e);
    return res.status(500).send(htmlPage('Erreur', 'âŒ Erreur serveur: '+e.message, '#E53935'));
  }
});

// â”€â”€ GET /api/admin/requests â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ POST /api/admin/requests/:id/approve â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/requests/:id/approve', adminMiddleware, async (req, res) => {
  try {
    const db = getDatabase();
    const requests = await db.query(
      `SELECT * FROM subscription_requests WHERE id=$1 LIMIT 1`, [req.params.id]
    );
    const request = requests[0];
    if (!request) return res.status(404).json({ error:'Demande introuvable.' });
    if (request.status !== 'pending')
      return res.status(400).json({ error:`Demande dÃ©jÃ  ${request.status}.` });

    const { expires_at } = await activateSubscription(db, request);
    const user = await db.findOne('users', { id:request.user_id });

    console.log(`[admin] Activation par panel: ${user?.pseudo}`);

    res.json({
      success:     true,
      message:     `Abonnement ${request.plan} activÃ© pour ${user?.pseudo}`,
      expires_at:  expires_at.toISOString(),
      user_pseudo: user?.pseudo
    });
  } catch(e) { res.status(500).json({ error:'Erreur activation.' }); }
});

// â”€â”€ POST /api/admin/requests/:id/reject â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/requests/:id/reject', adminMiddleware, async (req, res) => {
  try {
    const db = getDatabase();
    const requests = await db.query(
      `SELECT * FROM subscription_requests WHERE id=$1 LIMIT 1`, [req.params.id]
    );
    const request = requests[0];
    if (!request) return res.status(404).json({ error:'Demande introuvable.' });
    if (request.status !== 'pending')
      return res.status(400).json({ error:`DÃ©jÃ  ${request.status}.` });

    const { reason } = req.body;
    await db.update('subscription_requests', {
      status:'rejected',
      reviewed_at:   new Date().toISOString(),
      reject_reason: reason || 'Rejet admin'
    }, { id:request.id });

    const user = await db.findOne('users', { id:request.user_id });
    console.log(`[admin] Rejet par panel: ${user?.pseudo}`);

    res.json({ success:true, message:`Demande rejetÃ©e pour ${user?.pseudo}` });
  } catch(e) { res.status(500).json({ error:'Erreur rejet.' }); }
});

// â”€â”€ GET /api/admin/stats â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Utilitaire: page HTML simple pour les liens email â”€â”€â”€â”€â”€â”€â”€â”€â”€
function htmlPage(title, message, color='#1A73E8') {
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>${title}</title>
  <style>body{font-family:Arial,sans-serif;background:#f4f4f4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .box{background:white;border-radius:12px;padding:40px;max-width:480px;width:90%;text-align:center;border-top:4px solid ${color}}
  h2{color:${color};margin-top:0}p{color:#444;line-height:1.6}
  a{display:inline-block;margin-top:20px;background:${color};color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold}
  </style></head>
  <body><div class="box"><h2>${title}</h2><p>${message}</p><a href="javascript:history.back()">â† Retour</a></div></body></html>`;
}

module.exports = router;
                                   
