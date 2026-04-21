// ============================================================
// src/config/mailer.js — Service d'envoi d'emails
// ============================================================
// Utilise Nodemailer avec Gmail SMTP (gratuit)
//
// ── CONFIGURATION GMAIL ──────────────────────────────────────
// 1. Aller sur myaccount.google.com
// 2. Sécurité → Validation en 2 étapes → Activer
// 3. Sécurité → Mots de passe des applications → Créer
//    (choisir "Autre" → nommer "BobdoEduc")
// 4. Copier le mot de passe à 16 caractères généré
// 5. Mettre dans .env: GMAIL_PASS=xxxx xxxx xxxx xxxx
//
// ── AUTRES OPTIONS SMTP (si pas Gmail) ───────────────────────
// • Outlook/Hotmail: host=smtp-mail.outlook.com, port=587
// • Yahoo:           host=smtp.mail.yahoo.com,   port=465
// • Mailtrap (test): host=smtp.mailtrap.io,      port=2525
// • SendGrid:        npm install @sendgrid/mail  (gratuit 100/jour)
// • Brevo (Sendinblue): gratuit 300 emails/jour
// ============================================================
require('dotenv').config();
const nodemailer = require('nodemailer');

// ── Créer le transporteur SMTP ────────────────────────────────
function createTransport() {
  // Option A — Gmail (recommandé pour démarrer)
  if (process.env.EMAIL_PROVIDER === 'gmail' || !process.env.EMAIL_PROVIDER) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,  // ex: tonmail@gmail.com
        pass: process.env.GMAIL_PASS,  // mot de passe d'application (16 chars)
      },
    });
  }

  // Option B — SMTP personnalisé (Brevo, Mailtrap, hébergeur web...)
  if (process.env.EMAIL_PROVIDER === 'smtp') {
    return nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true', // true pour port 465
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }

  // Option C — Mode développement (log dans console, pas d'envoi réel)
  console.warn('[MAILER] Mode DEV — emails loggués en console uniquement');
  return {
    sendMail: async (opts) => {
      console.log('\n📧 [EMAIL DEV]');
      console.log('   À       :', opts.to);
      console.log('   Sujet   :', opts.subject);
      console.log('   Contenu :', opts.text || '(HTML)');
      console.log('────────────────────────────────\n');
      return { messageId: 'dev-' + Date.now() };
    }
  };
}

const transporter = createTransport();

// ── Templates emails ──────────────────────────────────────────

/**
 * Email envoyé à l'ADMIN quand un utilisateur soumet une demande d'abonnement
 */
function templateDemandeAdmin({ requestId, pseudo, phone, plan, amount, paymentPhone, paymentOperator, notes, activationUrl }) {
  const planLabel = plan === 'premium_yearly' ? 'Annuel (15 000 FCFA/an)' : 'Mensuel (3 000 FCFA/mois)';
  return {
    subject: `🔔 BobdoEduc — Nouvelle demande abonnement #${requestId.slice(0,8)}`,
    html: `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; background: #f4f4f4; margin: 0; padding: 20px; }
  .card { background: white; border-radius: 12px; padding: 28px; max-width: 560px; margin: 0 auto; border-top: 4px solid #1A73E8; }
  h2 { color: #1A73E8; margin-top: 0; }
  .info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #eee; }
  .label { color: #666; font-size: 13px; }
  .value { font-weight: bold; color: #222; }
  .highlight { background: #E8F0FE; border-radius: 8px; padding: 14px; margin: 16px 0; }
  .btn { display: inline-block; background: #1A73E8; color: white; padding: 14px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 8px 4px; }
  .btn-red { background: #E53935; }
  .btn-green { background: #00A854; }
  .footer { text-align: center; color: #999; font-size: 12px; margin-top: 20px; }
</style></head>
<body>
  <div class="card">
    <h2>🔔 Nouvelle demande d'abonnement</h2>
    <p style="color:#666">Un utilisateur a soumis une preuve de paiement. Vérifiez et activez manuellement.</p>

    <div class="highlight">
      <div class="info-row"><span class="label">ID Demande</span><span class="value">#${requestId.slice(0,8).toUpperCase()}</span></div>
      <div class="info-row"><span class="label">Utilisateur</span><span class="value">${pseudo}</span></div>
      <div class="info-row"><span class="label">Téléphone compte</span><span class="value">${phone || 'Non renseigné'}</span></div>
    </div>

    <h3 style="color:#00A854">💳 Détails du paiement déclaré</h3>
    <div class="info-row"><span class="label">Plan demandé</span><span class="value">${planLabel}</span></div>
    <div class="info-row"><span class="label">Montant déclaré</span><span class="value" style="color:#E8B923">${amount} FCFA</span></div>
    <div class="info-row"><span class="label">Opérateur</span><span class="value">${paymentOperator}</span></div>
    <div class="info-row"><span class="label">N° Mobile Money utilisé</span><span class="value">${paymentPhone}</span></div>
    ${notes ? `<div class="info-row"><span class="label">Message</span><span class="value">${notes}</span></div>` : ''}

    <div style="margin-top: 24px; text-align: center;">
      <p style="color:#333; margin-bottom:16px;"><strong>👉 Vérifiez votre téléphone ${paymentOperator} pour confirmer la réception de ${amount} FCFA depuis le ${paymentPhone}</strong></p>
      <a href="${activationUrl}&action=approve" class="btn btn-green">✅ Activer l'abonnement</a>
      <a href="${activationUrl}&action=reject"  class="btn btn-red">❌ Rejeter la demande</a>
    </div>

    <div style="margin-top:16px; background:#FFF9E6; border-radius:8px; padding:12px; font-size:13px; color:#666;">
      ⚠️ Ces liens fonctionnent pendant <strong>72 heures</strong>. Vous pouvez aussi utiliser le panel admin.
    </div>
  </div>
  <div class="footer">BobdoEduc · Système de gestion des abonnements</div>
</body>
</html>`,
    text: `Nouvelle demande abonnement BobdoEduc\nUtilisateur: ${pseudo}\nPlan: ${planLabel}\nMontant: ${amount} FCFA\nOpérateur: ${paymentOperator}\nN°: ${paymentPhone}\nActiver: ${activationUrl}&action=approve`
  };
}

/**
 * Email envoyé à l'UTILISATEUR — confirmation réception de sa demande
 */
function templateConfirmUser({ pseudo, plan, amount, paymentPhone }) {
  const planLabel = plan === 'premium_yearly' ? 'Annuel (1 an)' : 'Mensuel (1 mois)';
  return {
    subject: `✅ BobdoEduc — Demande reçue, activation en cours`,
    html: `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; background: #f4f4f4; padding: 20px; }
  .card { background: white; border-radius: 12px; padding: 28px; max-width: 520px; margin: 0 auto; border-top: 4px solid #00A854; }
  h2 { color: #00A854; }
  .info { background: #E8F5E9; border-radius: 8px; padding: 14px; margin: 16px 0; }
  .footer { text-align: center; color: #999; font-size: 12px; margin-top: 20px; }
</style></head>
<body>
  <div class="card">
    <h2>✅ Demande bien reçue, ${pseudo} !</h2>
    <p>Nous avons reçu votre demande d'abonnement <strong>${planLabel}</strong>.</p>
    <div class="info">
      <p>📱 Paiement depuis : <strong>${paymentPhone}</strong></p>
      <p>💰 Montant déclaré : <strong>${amount} FCFA</strong></p>
    </div>
    <p>⏳ Votre compte sera activé <strong>dans les 24 heures</strong> après vérification manuelle du paiement.</p>
    <p>Vous recevrez un email de confirmation dès l'activation.</p>
    <p style="color:#666; font-size:13px;">Si votre demande n'est pas activée dans 24h, contactez le support.</p>
  </div>
  <div class="footer">BobdoEduc · Plateforme éducative Burkina Faso</div>
</body>
</html>`,
    text: `Bonjour ${pseudo}, votre demande d'abonnement BobdoEduc a été reçue. Activation dans 24h.`
  };
}

/**
 * Email envoyé à l'UTILISATEUR — abonnement activé
 */
function templateActivated({ pseudo, plan, expiresAt }) {
  const planLabel = plan === 'premium_yearly' ? 'Annuel' : 'Mensuel';
  const expDate   = new Date(expiresAt).toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' });
  return {
    subject: `🎉 BobdoEduc — Votre abonnement Premium est actif !`,
    html: `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; background: #f4f4f4; padding: 20px; }
  .card { background: white; border-radius: 12px; padding: 28px; max-width: 520px; margin: 0 auto; border-top: 4px solid #E8B923; }
  h2 { color: #E8B923; }
  .badge { background: linear-gradient(135deg, #1A73E8, #7C3AED); color: white; border-radius: 20px; padding: 8px 20px; font-weight: bold; display: inline-block; margin: 16px 0; }
  .footer { text-align: center; color: #999; font-size: 12px; margin-top: 20px; }
</style></head>
<body>
  <div class="card">
    <h2>🎉 Félicitations ${pseudo} !</h2>
    <span class="badge">⭐ PREMIUM ${planLabel.toUpperCase()} ACTIVÉ</span>
    <p>Vous avez maintenant accès à tous les cycles :</p>
    <ul>
      <li>🏫 <strong>Cycle C</strong> — Primaire (CE1→CM2)</li>
      <li>📚 <strong>Cycle B</strong> — 1er Cycle (6ème→3ème)</li>
      <li>🎓 <strong>Cycle A</strong> — 2nd Cycle (2nde→Terminale)</li>
    </ul>
    <p>🗓️ Votre abonnement expire le <strong>${expDate}</strong>.</p>
    <p>Bon apprentissage ! 📖</p>
  </div>
  <div class="footer">BobdoEduc · Plateforme éducative Burkina Faso</div>
</body>
</html>`,
    text: `Félicitations ${pseudo} ! Votre abonnement Premium BobdoEduc est activé jusqu'au ${expDate}.`
  };
}

/**
 * Email rejet demande
 */
function templateRejected({ pseudo, reason }) {
  return {
    subject: `❌ BobdoEduc — Demande d'abonnement non validée`,
    html: `
<!DOCTYPE html>
<html lang="fr">
<head><meta charset="UTF-8"><style>
  body { font-family: Arial, sans-serif; background: #f4f4f4; padding: 20px; }
  .card { background: white; border-radius: 12px; padding: 28px; max-width: 520px; margin: 0 auto; border-top: 4px solid #E53935; }
  .footer { text-align: center; color: #999; font-size: 12px; margin-top: 20px; }
</style></head>
<body>
  <div class="card">
    <h2 style="color:#E53935">❌ Demande non validée</h2>
    <p>Bonjour ${pseudo},</p>
    <p>Nous n'avons pas pu valider votre demande d'abonnement.</p>
    ${reason ? `<p><strong>Raison :</strong> ${reason}</p>` : ''}
    <p>Si vous pensez qu'il s'agit d'une erreur, soumettez à nouveau votre demande ou contactez le support.</p>
  </div>
  <div class="footer">BobdoEduc · Support client</div>
</body>
</html>`,
    text: `Bonjour ${pseudo}, votre demande d'abonnement BobdoEduc n'a pas pu être validée. ${reason||''}`
  };
}

// ── Fonction principale d'envoi ───────────────────────────────
async function sendEmail({ to, ...template }) {
  try {
    const info = await transporter.sendMail({
      from: `"BobdoEduc" <${process.env.GMAIL_USER || process.env.SMTP_USER || 'noreply@bobdoeduc.bf'}>`,
      to,
      ...template
    });
    console.log(`[MAILER] ✅ Email envoyé à ${to} — ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[MAILER] ❌ Erreur envoi à ${to}:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = {
  sendEmail,
  templateDemandeAdmin,
  templateConfirmUser,
  templateActivated,
  templateRejected
};
