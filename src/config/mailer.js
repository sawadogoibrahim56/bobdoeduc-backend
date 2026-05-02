// ============================================================
// src/config/mailer.js â€” Service d'envoi d'emails
// ============================================================
// Utilise Nodemailer avec Gmail SMTP (gratuit)
//
// â”€â”€ CONFIGURATION GMAIL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// 1. Aller sur myaccount.google.com
// 2. SÃ©curitÃ© â†’ Validation en 2 Ã©tapes â†’ Activer
// 3. SÃ©curitÃ© â†’ Mots de passe des applications â†’ CrÃ©er
//    (choisir "Autre" â†’ nommer "BobdoEduc")
// 4. Copier le mot de passe Ã  16 caractÃ¨res gÃ©nÃ©rÃ©
// 5. Mettre dans .env: GMAIL_PASS=xxxx xxxx xxxx xxxx
//
// â”€â”€ AUTRES OPTIONS SMTP (si pas Gmail) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// â€¢ Outlook/Hotmail: host=smtp-mail.outlook.com, port=587
// â€¢ Yahoo:           host=smtp.mail.yahoo.com,   port=465
// â€¢ Mailtrap (test): host=smtp.mailtrap.io,      port=2525
// â€¢ SendGrid:        npm install @sendgrid/mail  (gratuit 100/jour)
// â€¢ Brevo (Sendinblue): gratuit 300 emails/jour
// ============================================================
require('dotenv').config();
const nodemailer = require('nodemailer');

// â”€â”€ CrÃ©er le transporteur SMTP â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function createTransport() {
  // Option A â€” Gmail (recommandÃ© pour dÃ©marrer)
  if (process.env.EMAIL_PROVIDER === 'gmail' || !process.env.EMAIL_PROVIDER) {
    // âœ… FIX: fallback console si Gmail non configurÃ©
    if (!process.env.GMAIL_USER || !process.env.GMAIL_PASS ||
        process.env.GMAIL_PASS === 'xxxx xxxx xxxx xxxx') {
      console.warn('[MAILER] Gmail non configurÃ© â†’ mode console DEV');
      return {
        sendMail: async (opts) => {
          console.log('\nðŸ“§ [EMAIL DEV - Gmail non configurÃ©]');
          console.log('   Ã€       :', opts.to);
          console.log('   Sujet   :', opts.subject);
          console.log('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n');
          return { messageId: 'dev-' + Date.now() };
        }
      };
    }
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_PASS,
      },
    });
  }

  // Option B â€” SMTP personnalisÃ© (Brevo, Mailtrap, hÃ©bergeur web...)
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

  // Option C â€” Mode dÃ©veloppement (log dans console, pas d'envoi rÃ©el)
  console.warn('[MAILER] Mode DEV â€” emails logguÃ©s en console uniquement');
  return {
    sendMail: async (opts) => {
      console.log('\nðŸ“§ [EMAIL DEV]');
      console.log('   Ã€       :', opts.to);
      console.log('   Sujet   :', opts.subject);
      console.log('   Contenu :', opts.text || '(HTML)');
      console.log('â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n');
      return { messageId: 'dev-' + Date.now() };
    }
  };
}

const transporter = createTransport();

// â”€â”€ Templates emails â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Email envoyÃ© Ã  l'ADMIN quand un utilisateur soumet une demande d'abonnement
 */
function templateDemandeAdmin({ requestId, pseudo, phone, plan, amount, paymentPhone, paymentOperator, notes, activationUrl }) {
  const planLabel = plan === 'premium_yearly' ? 'Annuel (15 000 FCFA/an)' : 'Mensuel (3 000 FCFA/mois)';
  return {
    subject: `ðŸ”” BobdoEduc â€” Nouvelle demande abonnement #${requestId.slice(0,8)}`,
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
    <h2>ðŸ”” Nouvelle demande d'abonnement</h2>
    <p style="color:#666">Un utilisateur a soumis une preuve de paiement. VÃ©rifiez et activez manuellement.</p>

    <div class="highlight">
      <div class="info-row"><span class="label">ID Demande</span><span class="value">#${requestId.slice(0,8).toUpperCase()}</span></div>
      <div class="info-row"><span class="label">Utilisateur</span><span class="value">${pseudo}</span></div>
      <div class="info-row"><span class="label">TÃ©lÃ©phone compte</span><span class="value">${phone || 'Non renseignÃ©'}</span></div>
    </div>

    <h3 style="color:#00A854">ðŸ’³ DÃ©tails du paiement dÃ©clarÃ©</h3>
    <div class="info-row"><span class="label">Plan demandÃ©</span><span class="value">${planLabel}</span></div>
    <div class="info-row"><span class="label">Montant dÃ©clarÃ©</span><span class="value" style="color:#E8B923">${amount} FCFA</span></div>
    <div class="info-row"><span class="label">OpÃ©rateur</span><span class="value">${paymentOperator}</span></div>
    <div class="info-row"><span class="label">NÂ° Mobile Money utilisÃ©</span><span class="value">${paymentPhone}</span></div>
    ${notes ? `<div class="info-row"><span class="label">Message</span><span class="value">${notes}</span></div>` : ''}

    <div style="margin-top: 24px; text-align: center;">
      <p style="color:#333; margin-bottom:16px;"><strong>ðŸ‘‰ VÃ©rifiez votre tÃ©lÃ©phone ${paymentOperator} pour confirmer la rÃ©ception de ${amount} FCFA depuis le ${paymentPhone}</strong></p>
      <a href="${activationUrl}&action=approve" class="btn btn-green">âœ… Activer l'abonnement</a>
      <a href="${activationUrl}&action=reject"  class="btn btn-red">âŒ Rejeter la demande</a>
    </div>

    <div style="margin-top:16px; background:#FFF9E6; border-radius:8px; padding:12px; font-size:13px; color:#666;">
      âš ï¸ Ces liens fonctionnent pendant <strong>72 heures</strong>. Vous pouvez aussi utiliser le panel admin.
    </div>
  </div>
  <div class="footer">BobdoEduc Â· SystÃ¨me de gestion des abonnements</div>
</body>
</html>`,
    text: `Nouvelle demande abonnement BobdoEduc\nUtilisateur: ${pseudo}\nPlan: ${planLabel}\nMontant: ${amount} FCFA\nOpÃ©rateur: ${paymentOperator}\nNÂ°: ${paymentPhone}\nActiver: ${activationUrl}&action=approve`
  };
   }

/**
 * Email envoyÃ© Ã  l'UTILISATEUR â€” confirmation rÃ©ception de sa demande
 */
function templateConfirmUser({ pseudo, plan, amount, paymentPhone }) {
  const planLabel = plan === 'premium_yearly' ? 'Annuel (1 an)' : 'Mensuel (1 mois)';
  return {
    subject: `âœ… BobdoEduc â€” Demande reÃ§ue, activation en cours`,
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
    <h2>âœ… Demande bien reÃ§ue, ${pseudo} !</h2>
    <p>Nous avons reÃ§u votre demande d'abonnement <strong>${planLabel}</strong>.</p>
    <div class="info">
      <p>ðŸ“± Paiement depuis : <strong>${paymentPhone}</strong></p>
      <p>ðŸ’° Montant dÃ©clarÃ© : <strong>${amount} FCFA</strong></p>
    </div>
    <p>â³ Votre compte sera activÃ© <strong>dans les 24 heures</strong> aprÃ¨s vÃ©rification manuelle du paiement.</p>
    <p>Vous recevrez un email de confirmation dÃ¨s l'activation.</p>
    <p style="color:#666; font-size:13px;">Si votre demande n'est pas activÃ©e dans 24h, contactez le support.</p>
  </div>
  <div class="footer">BobdoEduc Â· Plateforme Ã©ducative Burkina Faso</div>
</body>
</html>`,
    text: `Bonjour ${pseudo}, votre demande d'abonnement BobdoEduc a Ã©tÃ© reÃ§ue. Activation dans 24h.`
  };
}

/**
 * Email envoyÃ© Ã  l'UTILISATEUR â€” abonnement activÃ©
 */
function templateActivated({ pseudo, plan, expiresAt }) {
  const planLabel = plan === 'premium_yearly' ? 'Annuel' : 'Mensuel';
  const expDate   = new Date(expiresAt).toLocaleDateString('fr-FR', { day:'numeric', month:'long', year:'numeric' });
  return {
    subject: `ðŸŽ‰ BobdoEduc â€” Votre abonnement Premium est actif !`,
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
    <h2>ðŸŽ‰ FÃ©licitations ${pseudo} !</h2>
    <span class="badge">â­ PREMIUM ${planLabel.toUpperCase()} ACTIVÃ‰</span>
    <p>Vous avez maintenant accÃ¨s Ã  tous les cycles :</p>
    <ul>
      <li>ðŸ« <strong>Cycle C</strong> â€” Primaire (CE1â†’CM2)</li>
      <li>ðŸ“š <strong>Cycle B</strong> â€” 1er Cycle (6Ã¨meâ†’3Ã¨me)</li>
      <li>ðŸŽ“ <strong>Cycle A</strong> â€” 2nd Cycle (2ndeâ†’Terminale)</li>
    </ul>
    <p>ðŸ—“ï¸ Votre abonnement expire le <strong>${expDate}</strong>.</p>
    <p>Bon apprentissage ! ðŸ“–</p>
  </div>
  <div class="footer">BobdoEduc Â· Plateforme Ã©ducative Burkina Faso</div>
</body>
</html>`,
    text: `FÃ©licitations ${pseudo} ! Votre abonnement Premium BobdoEduc est activÃ© jusqu'au ${expDate}.`
  };
}

/**
 * Email rejet demande
 */
function templateRejected({ pseudo, reason }) {
  return {
    subject: `âŒ BobdoEduc â€” Demande d'abonnement non validÃ©e`,
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
    <h2 style="color:#E53935">âŒ Demande non validÃ©e</h2>
    <p>Bonjour ${pseudo},</p>
    <p>Nous n'avons pas pu valider votre demande d'abonnement.</p>
    ${reason ? `<p><strong>Raison :</strong> ${reason}</p>` : ''}
    <p>Si vous pensez qu'il s'agit d'une erreur, soumettez Ã  nouveau votre demande ou contactez le support.</p>
  </div>
  <div class="footer">BobdoEduc Â· Support client</div>
</body>
</html>`,
    text: `Bonjour ${pseudo}, votre demande d'abonnement BobdoEduc n'a pas pu Ãªtre validÃ©e. ${reason||''}`
  };
}

// â”€â”€ Fonction principale d'envoi â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function sendEmail({ to, ...template }) {
  try {
    const info = await transporter.sendMail({
      from: `"BobdoEduc" <${process.env.GMAIL_USER || process.env.SMTP_USER || 'noreply@bobdoeduc.bf'}>`,
      to,
      ...template
    });
    console.log(`[MAILER] âœ… Email envoyÃ© Ã  ${to} â€” ID: ${info.messageId}`);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[MAILER] âŒ Erreur envoi Ã  ${to}:`, err.message);
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
    
