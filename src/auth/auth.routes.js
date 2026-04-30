// ============================================================
// src/auth/auth.routes.js â€” Authentification BobdoEduc
// OTP par EMAIL ou SMS (au choix de l'utilisateur)
// ============================================================
'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { getDatabase } = require('../config/database');
const { sendEmail }   = require('../config/mailer');

const router = express.Router();

// â”€â”€ UTILITAIRES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const hashPhone = p => crypto.createHash('sha256').update(p.replace(/\s/g,'')).digest('hex');
const hashEmail = e => crypto.createHash('sha256').update(e.toLowerCase().trim()).digest('hex');

function encryptData(data) {
  const keyHex = process.env.ENCRYPTION_KEY || '';
  const keyBuf = keyHex.length >= 64
    ? Buffer.from(keyHex.slice(0,64), 'hex')
    : crypto.createHash('sha256').update(keyHex).digest();
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, iv);
  const enc    = Buffer.concat([cipher.update(data), cipher.final()]);
  return iv.toString('hex') + ':' + enc.toString('hex');
}

function generateOtp() { return Math.floor(100000 + Math.random() * 900000).toString(); }

function generateTokens(userId) {
  const at = jwt.sign({ sub:userId, type:'access' }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN||'15m' });
  const rt = crypto.randomBytes(64).toString('hex');
  return { accessToken:at, refreshToken:rt };
}

async function logAudit(userId, action, status, req, meta={}) {
  try {
    const db = getDatabase();
    await db.insert('audit_logs', { user_id:userId||null, action, status, ip_address:req.ip, user_agent:req.headers['user-agent'], metadata:JSON.stringify(meta) });
  } catch(e) { console.error('[audit]', e.message); }
}

async function sendOtpByEmail(email, otp, purpose) {
  const subject = purpose === 'register' ? 'BobdoEduc â€” Code de vÃ©rification' : 'BobdoEduc â€” Code de rÃ©initialisation';
  const html = `<div style="font-family:Arial,sans-serif;max-width:400px;margin:auto;padding:20px;border:1px solid #eee;border-radius:8px;"><h2 style="color:#2563eb;">BobdoEduc</h2><p>Votre code de vÃ©rification :</p><div style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#1d4ed8;text-align:center;padding:20px;background:#eff6ff;border-radius:8px;">${otp}</div><p style="color:#666;font-size:14px;">Expire dans <strong>10 minutes</strong>.</p></div>`;
  return await sendEmail({ to:email, subject, html });
}

// â”€â”€ POST /api/auth/send-otp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/send-otp', async (req, res) => {
  try {
    const { phone, email, purpose='register' } = req.body;
    if (!email && !phone) return res.status(400).json({ error:'Email ou numÃ©ro de tÃ©lÃ©phone requis.' });

    const db = getDatabase();
    let identifier_hash, contact_type, contact_display;

    if (email) {
      const emailNorm = email.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm)) return res.status(400).json({ error:'Adresse email invalide.' });
      identifier_hash = hashEmail(emailNorm);
      contact_type    = 'email';
      contact_display = emailNorm.replace(/(.{2}).*(@.*)/, '$1***$2');
      if (purpose === 'register') {
        const existing = await db.findOne('users', { email_hash:identifier_hash });
        if (existing) return res.status(409).json({ error:'Cet email est dÃ©jÃ  inscrit.' });
      }
    } else {
      const phoneNorm = phone.replace(/\s/g,'');
      if (!/^\+?[0-9]{8,15}$/.test(phoneNorm)) return res.status(400).json({ error:'NumÃ©ro invalide.' });
      identifier_hash = hashPhone(phoneNorm);
      contact_type    = 'phone';
      contact_display = phoneNorm.slice(0,4) + '****' + phoneNorm.slice(-2);
      if (purpose === 'register') {
        const existing = await db.findOne('users', { phone_hash:identifier_hash });
        if (existing) return res.status(409).json({ error:'Ce numÃ©ro est dÃ©jÃ  inscrit.' });
      }
    }

    await db.query(`UPDATE otp_tokens SET is_used=true WHERE phone_hash=$1 AND purpose=$2 AND is_used=false`, [identifier_hash, purpose]);

    const otp        = generateOtp();
    const token_hash = await bcrypt.hash(otp, parseInt(process.env.BCRYPT_ROUNDS_OTP)||8);
    const expires_at = new Date(Date.now() + 10*60*1000).toISOString();

    await db.insert('otp_tokens', { phone_hash:identifier_hash, token_hash, purpose, expires_at, ip_address:req.ip });

    if (contact_type === 'email') {
      await sendOtpByEmail(email, otp, purpose);
    } else {
      console.log(`[OTP SMS] ${phone}: ${otp}`);
    }

    const isDev = process.env.NODE_ENV !== 'production';
    if (isDev) console.log(`[DEV OTP] ${contact_display}: ${otp}`);

    await logAudit(null, 'send_otp', 'success', req, { identifier_hash, purpose, contact_type });
    res.json({
      success:true,
      message: contact_type === 'email' ? `Code OTP envoyÃ© Ã  ${contact_display}` : `Code OTP envoyÃ© au ${contact_display}`,
      contact_type,
      ...(isDev && { dev_otp: otp })
    });
  } catch(e) {
    console.error('[send-otp]', e);
    res.status(500).json({ error:'Erreur envoi OTP.' });
  }
});

// â”€â”€ POST /api/auth/verify-otp â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, email, otp, purpose='register' } = req.body;
    if (!otp || (!phone && !email)) return res.status(400).json({ error:'DonnÃ©es manquantes.' });

    const db = getDatabase();
    const identifier_hash = email ? hashEmail(email.toLowerCase().trim()) : hashPhone(phone.replace(/\s/g,''));

    const tokens = await db.query(
      `SELECT * FROM otp_tokens WHERE phone_hash=$1 AND purpose=$2 AND is_used=false AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [identifier_hash, purpose]
    );
    const token = tokens[0];
    if (!token) return res.status(400).json({ error:'OTP invalide ou expirÃ©. Redemandez un code.' });
    if (token.attempts >= 5) return res.status(429).json({ error:'Trop de tentatives. Demandez un nouveau code.' });

    await db.query(`UPDATE otp_tokens SET attempts = attempts + 1 WHERE id = $1`, [token.id]);

    const valid = await bcrypt.compare(otp, token.token_hash);
    if (!valid) return res.status(400).json({ error:'Code incorrect.' });

    await db.query(`UPDATE otp_tokens SET is_used=true WHERE id=$1`, [token.id]);

    const verifyToken = jwt.sign(
      { identifier_hash, purpose, verified:true, contact_type: email ? 'email' : 'phone' },
      process.env.JWT_SECRET, { expiresIn:'30m' }
    );
    res.json({ success:true, verify_token:verifyToken });
  } catch(e) {
    console.error('[verify-otp]', e);
    res.status(500).json({ error:'Erreur vÃ©rification OTP.' });
  }
});

// â”€â”€ POST /api/auth/register â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/register', async (req, res) => {
  try {
    const { phone, email, password, pseudo, verify_token } = req.body;
    if (!password || !pseudo || !verify_token) return res.status(400).json({ error:'Tous les champs sont requis.' });
    if (!phone && !email) return res.status(400).json({ error:'Email ou tÃ©lÃ©phone requis.' });
    if (password.length < 8) return res.status(400).json({ error:'Mot de passe minimum 8 caractÃ¨res.' });
    if (pseudo.length < 2 || pseudo.length > 30) return res.status(400).json({ error:'Pseudo entre 2 et 30 caractÃ¨res.' });

    let decoded;
    try { decoded = jwt.verify(verify_token, process.env.JWT_SECRET); }
    catch { return res.status(400).json({ error:"Session OTP expirÃ©e. Recommencez l'inscription." }); }
    if (!decoded.verified || decoded.purpose !== 'register') return res.status(400).json({ error:'Token invalide.' });

    const db = getDatabase();
    let userData = {};

    if (decoded.contact_type === 'email' && email) {
      const email_hash = hashEmail(email.toLowerCase().trim());
      if (decoded.identifier_hash !== email_hash) return res.status(400).json({ error:'Email ne correspond pas au code OTP.' });
      const existing = await db.findOne('users', { email_hash });
      if (existing) return res.status(409).json({ error:'Email dÃ©jÃ  inscrit.' });
      userData.email_hash      = email_hash;
      userData.email_encrypted = encryptData(email.toLowerCase().trim());
    } else if (decoded.contact_type === 'phone' && phone) {
      const phoneNorm  = phone.replace(/\s/g,'');
      const phone_hash = hashPhone(phoneNorm);
      if (decoded.identifier_hash !== phone_hash) return res.status(400).json({ error:'NumÃ©ro ne correspond pas au code OTP.' });
      const existing = await db.findOne('users', { phone_hash });
      if (existing) return res.status(409).json({ error:'NumÃ©ro dÃ©jÃ  inscrit.' });
      userData.phone_hash      = phone_hash;
      userData.phone_encrypted = encryptData(phoneNorm);
    } else {
      return res.status(400).json({ error:'Contact invalide.' });
    }

    const existingPs = await db.findOne('users', { pseudo });
    if (existingPs) return res.status(409).json({ error:'Ce pseudo est dÃ©jÃ  pris.' });

    const password_hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS_PASSWORD)||12);
    const user = await db.insert('users', { ...userData, pseudo, password_hash, is_verified:true, plan:'free', quiz_free_used:0 });

    const { accessToken, refreshToken } = generateTokens(user.id);
    const rt_hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await db.insert('refresh_tokens', { user_id:user.id, token_hash:rt_hash, expires_at:new Date(Date.now()+30*24*60*60*1000).toISOString(), ip_address:req.ip, user_agent:req.headers['user-agent'] });

    await logAudit(user.id, 'register', 'success', req);
    const FREE_LIMIT = parseInt(process.env.FREE_QUIZ_LIMIT)||20;
    res.status(201).json({
      success:true,
      user:{ id:user.id, pseudo:user.pseudo, plan:user.plan, quiz_free_used:0, quiz_free_remaining:FREE_LIMIT },
      access_token:accessToken, refresh_token:refreshToken
    });
  } catch(e) {
    console.error('[register]', e);
    res.status(500).json({ error:'Erreur inscription.' });
  }
});

// â”€â”€ POST /api/auth/login â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/login', async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    if (!password || (!phone && !email)) return res.status(400).json({ error:'DonnÃ©es manquantes.' });

    const db = getDatabase();
    let user;
    if (email) {
      user = await db.findOne('users', { email_hash: hashEmail(email.toLowerCase().trim()) });
    } else {
      user = await db.findOne('users', { phone_hash: hashPhone(phone.replace(/\s/g,'')) });
    }

    if (!user) { await logAudit(null,'login','failed',req,{reason:'not_found'}); return res.status(401).json({ error:'Identifiant ou mot de passe incorrect.' }); }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const rem = Math.ceil((new Date(user.locked_until)-new Date())/60000);
      return res.status(423).json({ error:`Compte bloquÃ©. RÃ©essayez dans ${rem} minutes.` });
    }
    if (user.is_banned) return res.status(403).json({ error:'Compte suspendu. Contactez le support.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const att = (user.failed_login_attempts||0)+1;
      const upd = { failed_login_attempts:att };
      if (att >= 5) upd.locked_until = new Date(Date.now()+30*60*1000).toISOString();
      await db.update('users', upd, { id:user.id });
      await logAudit(user.id,'login','failed',req,{attempts:att});
      return res.status(401).json({ error:'Identifiant ou mot de passe incorrect.' });
    }

    await db.update('users', { failed_login_attempts:0, locked_until:null, last_login:new Date().toISOString() }, { id:user.id });

    const { accessToken, refreshToken } = generateTokens(user.id);
    const rt_hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await db.insert('refresh_tokens', { user_id:user.id, token_hash:rt_hash, expires_at:new Date(Date.now()+30*24*60*60*1000).toISOString(), ip_address:req.ip, user_agent:req.headers['user-agent'] });

    const FREE_LIMIT = parseInt(process.env.FREE_QUIZ_LIMIT)||20;
    const isPremium  = user.plan !== 'free' && user.subscription_end && new Date(user.subscription_end) > new Date();
    await logAudit(user.id,'login','success',req);
    res.json({
      success:true,
      user:{ id:user.id, pseudo:user.pseudo, plan:user.plan, is_premium:isPremium, quiz_free_used:user.quiz_free_used||0, quiz_free_remaining:Math.max(0,FREE_LIMIT-(user.quiz_free_used||0)), subscription_end:user.subscription_end, total_correct:user.total_correct||0, total_wrong:user.total_wrong||0, total_sessions:user.total_sessions||0 },
      access_token:accessToken, refresh_token:refreshToken
    });
  } catch(e) {
    console.error('[login]', e);
    res.status(500).json({ error:'Erreur connexion.' });
  }
});

// â”€â”€ POST /api/auth/refresh â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error:'Refresh token requis.' });
    const db = getDatabase();
    const rt_hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
    const tokens  = await db.query(`SELECT * FROM refresh_tokens WHERE token_hash=$1 AND is_revoked=false AND expires_at > NOW() LIMIT 1`, [rt_hash]);
    const token = tokens[0];
    if (!token) return res.status(401).json({ error:'Token invalide ou expirÃ©.' });
    await db.update('refresh_tokens', { is_revoked:true }, { id:token.id });
    const { accessToken, refreshToken:newRt } = generateTokens(token.user_id);
    const new_rt_hash = crypto.createHash('sha256').update(newRt).digest('hex');
    await db.insert('refresh_tokens', { user_id:token.user_id, token_hash:new_rt_hash, expires_at:new Date(Date.now()+30*24*60*60*1000).toISOString(), ip_address:req.ip, user_agent:req.headers['user-agent'] });
    res.json({ access_token:accessToken, refresh_token:newRt });
  } catch(e) { res.status(500).json({ error:'Erreur renouvellement.' }); }
});

// â”€â”€ POST /api/auth/logout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/logout', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (refresh_token) {
      const db = getDatabase();
      const rt_hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
      await db.update('refresh_tokens', { is_revoked:true }, { token_hash:rt_hash });
    }
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Erreur dÃ©connexion.' }); }
});

// â”€â”€ POST /api/auth/forgot-password â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.post('/forgot-password', async (req, res) => {
  try {
    const { phone, email } = req.body;
    if (!phone && !email) return res.status(400).json({ error:'Email ou tÃ©lÃ©phone requis.' });
    const db = getDatabase();
    let user;
    if (email) { user = await db.findOne('users', { email_hash: hashEmail(email.toLowerCase().trim()) }); }
    else        { user = await db.findOne('users', { phone_hash: hashPhone(phone.replace(/\s/g,'')) }); }
    if (user) {
      const otp = generateOtp();
      const token_hash = await bcrypt.hash(otp, 8);
      const identifier_hash = email ? hashEmail(email.toLowerCase().trim()) : hashPhone(phone.replace(/\s/g,''));
      await db.query(`UPDATE otp_tokens SET is_used=true WHERE phone_hash=$1 AND purpose='reset_password' AND is_used=false`, [identifier_hash]);
      await db.insert('otp_tokens', { phone_hash:identifier_hash, token_hash, purpose:'reset_password', expires_at:new Date(Date.now()+10*60*1000).toISOString(), ip_address:req.ip });
      if (email) { await sendOtpByEmail(email, otp, 'reset_password'); }
      else { console.log(`[RESET OTP] ${phone}: ${otp}`); }
    }
    res.json({ success:true, message:'Si ce contact est enregistrÃ©, un code a Ã©tÃ© envoyÃ©.' });
  } catch(e) { res.status(500).json({ error:'Erreur.' }); }
});

module.exports = router;
      
