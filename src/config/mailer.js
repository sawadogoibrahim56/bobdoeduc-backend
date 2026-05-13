// ============================================================
// src/config/mailer.js — BobdoEduc
// Supporte: Resend (prod), Brevo (SMTP), console (dev)
// ============================================================
'use strict';
require('dotenv').config();

// ── Resend (HTTP, port 443 — compatible Render free tier) ────
let _resend = null;
function getResend() {
  if (!_resend) {
    const { Resend } = require('resend');
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

// ── Nodemailer (Brevo / SMTP générique) ──────────────────────
let _transporter = null;
function getTransporter() {
  if (!_transporter) {
    const nodemailer = require('nodemailer');
    console.log('[MAILER] SMTP configuré:', process.env.SMTP_HOST);
    _transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST   || 'smtp-relay.brevo.com',
      port:   parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
      tls: { rejectUnauthorized: false }
    });
  }
  return _transporter;
}

// ── Envoyer un email ──────────────────────────────────────────
async function sendEmail({ to, subject, html, text }) {
  const provider = process.env.EMAIL_PROVIDER || 'console';

  // ── MODE CONSOLE (dev) ────────────────────────────────────
  if (provider === 'console') {
    console.log('\n' + '═'.repeat(50));
    console.log('📧 EMAIL (mode console)');
    console.log('   À      :', to);
    console.log('   Sujet  :', subject);
    const otpMatch = html && html.match(/letter-spacing:10px[^>]*>(\d{6})</);
    if (otpMatch) console.log('   OTP    :', otpMatch[1]);
    console.log('═'.repeat(50) + '\n');
    return { success: true, messageId: 'console-' + Date.now() };
  }

  // ── RESEND (recommandé sur Render) ────────────────────────
  if (provider === 'resend') {
    if (!process.env.RESEND_API_KEY) {
      console.warn('[MAILER] RESEND_API_KEY manquante → mode console');
      return sendEmail({ to, subject, html, text });
    }
    try {
      const resend = getResend();
      const from = process.env.EMAIL_FROM || 'BobdoEduc <noreply@bobdoeduc.com>';
      const { data, error } = await resend.emails.send({ from, to, subject, html, text });
      if (error) throw new Error(error.message);
      console.log('[MAILER] Email envoyé via Resend à', to, '- ID:', data.id);
      return { success: true, messageId: data.id };
    } catch (e) {
      console.error('[MAILER] Erreur Resend à', to, ':', e.message);
      return { success: false, error: e.message };
    }
  }

  // ── BREVO / SMTP GÉNÉRIQUE ────────────────────────────────
  if (provider === 'brevo' || provider === 'smtp') {
    try {
      const transporter = getTransporter();
      const from = process.env.EMAIL_FROM
        || `"BobdoEduc" <${process.env.SMTP_USER || 'noreply@bobdoeduc.com'}>`;
      const result = await transporter.sendMail({ from, to, subject, html, text });
      console.log('[MAILER] Email envoyé via SMTP à', to, '- ID:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (e) {
      console.error('[MAILER] Erreur SMTP à', to, ':', e.message);
      return { success: false, error: e.message };
    }
  }

  // Fallback console
  console.warn('[MAILER] Provider inconnu:', provider, '→ mode console');
  return sendEmail({ to, subject, html, text });
}

// ── Templates (inchangés) ──────────────────────────────────────
function templateOTP(otp, purpose) {
  const isReset = purpose === 'reset_password';
  return {
    subject: isReset ? 'BobdoEduc — Réinitialisation mot de passe' : 'BobdoEduc — Code de vérification',
    html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#f5f5f5">
<div style="max-width:420px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1)">
  <div style="background:linear-gradient(135deg,#1A73E8,#0D47A1);padding:28px 24px;text-align:center">
    <h1 style="color:#fff;margin:0;font-size:24px;font-weight:800;letter-spacing:-1px">BobdoEduc</h1>
    <p style="color:rgba(255,255,255,.8);margin:6px 0 0;font-size:13px">Plateforme éducative du Burkina Faso 🇧🇫</p>
  </div>
  <div style="padding:32px 24px;text-align:center">
    <p style="color:#333;font-size:16px;margin:0 0 8px">${isReset ? 'Code de réinitialisation' : 'Votre code de vérification'}</p>
    <div style="font-size:42px;font-weight:800;letter-spacing:10px;color:#1A73E8;padding:20px;background:#EEF4FF;border-radius:12px;margin:16px 0;font-family:monospace">${otp}</div>
    <p style="color:#666;font-size:14px;margin:0">⏰ Ce code expire dans <strong>10 minutes</strong></p>
    <p style="color:#999;font-size:12px;margin:16px 0 0">Si vous n'avez pas demandé ce code, ignorez cet email.</p>
  </div>
  <div style="background:#f9f9f9;padding:16px 24px;text-align:center;border-top:1px solid #eee">
    <p style="color:#999;font-size:11px;margin:0">© 2025 BobdoEduc · Burkina Faso</p>
  </div>
</div>
</body></html>`
  };
}

function templateDemandeAdmin({ requestId, pseudo, phone, plan, amount, paymentPhone, paymentOperator, notes, activationUrl }) {
  return {
    subject: `[BobdoEduc Admin] Nouvelle demande d'abonnement — ${pseudo}`,
    html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#f5f5f5">
<div style="max-width:480px;margin:auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,.1)">
  <h2 style="color:#1A73E8;margin:0 0 20px">🔔 Nouvelle demande d'abonnement</h2>
  <table style="width:100%;border-collapse:collapse">
    <tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">Utilisateur</td><td style="padding:8px 0;font-weight:700">${pseudo}</td></tr>
    <tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">Plan</td><td style="padding:8px 0;font-weight:700">${plan === 'premium_yearly' ? '📅 Annuel' : '📆 Mensuel'}</td></tr>
    <tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">Montant déclaré</td><td style="padding:8px 0;font-weight:700;color:#E8B923">${(amount||0).toLocaleString('fr-FR')} FCFA</td></tr>
    <tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">Opérateur</td><td style="padding:8px 0;font-weight:700">${paymentOperator}</td></tr>
    <tr style="border-bottom:1px solid #eee"><td style="padding:8px 0;color:#666">N° Mobile Money</td><td style="padding:8px 0;font-weight:700;color:#00A854">${paymentPhone}</td></tr>
    ${notes ? `<tr><td style="padding:8px 0;color:#666">Message</td><td style="padding:8px 0">${notes}</td></tr>` : ''}
  </table>
  <div style="background:#EEF4FF;border-radius:8px;padding:16px;margin:20px 0;text-align:center">
    <p style="margin:0 0 12px;color:#333;font-weight:600">Vérifiez le paiement et activez :</p>
    <a href="${activationUrl}" style="background:#00A854;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px">✅ Voir dans le Panel Admin</a>
  </div>
  <p style="color:#999;font-size:12px">ID demande: ${requestId}</p>
</div>
</body></html>`
  };
}

function templateActivated({ pseudo, plan, expiresAt }) {
  return {
    subject: '⭐ BobdoEduc — Abonnement Premium activé !',
    html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#f5f5f5">
<div style="max-width:420px;margin:auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1)">
  <div style="background:linear-gradient(135deg,#7C3AED,#1A73E8);padding:28px;text-align:center">
    <div style="font-size:48px">⭐</div>
    <h2 style="color:#fff;margin:8px 0 0">Premium Activé !</h2>
  </div>
  <div style="padding:28px;text-align:center">
    <p style="font-size:16px;color:#333">Bonjour <strong>${pseudo}</strong>,</p>
    <p style="color:#555">Votre abonnement <strong>${plan === 'premium_yearly' ? 'Annuel' : 'Mensuel'}</strong> est maintenant actif.</p>
    <p style="color:#666;font-size:14px">Expire le: <strong>${new Date(expiresAt).toLocaleDateString('fr-FR')}</strong></p>
    <p style="color:#555;margin-top:16px">Profitez de quiz illimités sur tous les cycles ! 🚀</p>
  </div>
</div>
</body></html>`
  };
}

function templateRejected({ pseudo, reason }) {
  return {
    subject: "BobdoEduc — Demande d'abonnement non validée",
    html: `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#f5f5f5">
<div style="max-width:420px;margin:auto;background:#fff;border-radius:12px;padding:28px;box-shadow:0 4px 20px rgba(0,0,0,.1)">
  <h2 style="color:#E53935">Demande non validée</h2>
  <p>Bonjour <strong>${pseudo}</strong>,</p>
  <p style="color:#555">Votre demande d'abonnement n'a pas pu être validée.</p>
  ${reason ? `<p style="background:#FFF3F3;border-left:3px solid #E53935;padding:10px;color:#666">Raison: ${reason}</p>` : ''}
  <p style="color:#555">Vous pouvez soumettre une nouvelle demande depuis l'application.</p>
</div>
</body></html>`
  };
}

function templateConfirmUser({ pseudo, plan, expiresAt }) {
  return templateActivated({ pseudo, plan, expiresAt });
}

module.exports = {
  sendEmail,
  templateOTP,
  templateDemandeAdmin,
  templateActivated,
  templateRejected,
  templateConfirmUser
};
