// ============================================================
// src/auth/auth.routes.js — Authentification BobdoEduc
// ============================================================
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { getDatabase } = require('../config/database');

const router = express.Router();

// ── UTILITAIRES ───────────────────────────────────────────────
const hashPhone = p => crypto.createHash('sha256').update(p.replace(/\s/g,'')).digest('hex');

function encryptPhone(phone) {
  const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
  const iv  = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const enc = Buffer.concat([cipher.update(phone), cipher.final()]);
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

// ── POST /api/auth/send-otp ───────────────────────────────────
router.post('/send-otp', async (req, res) => {
  try {
    const { phone, purpose='register' } = req.body;
    const phoneNorm = phone?.replace(/\s/g,'');
    if (!phoneNorm || !/^\+226[0-9]{8}$/.test(phoneNorm))
      return res.status(400).json({ error:'Numéro invalide. Format: +226XXXXXXXX' });

    const db = getDatabase();
    const phone_hash = hashPhone(phoneNorm);

    if (purpose === 'register') {
      const existing = await db.findOne('users', { phone_hash });
      if (existing) return res.status(409).json({ error:'Ce numéro est déjà inscrit.' });
    }

    // Invalider anciens OTP
    await db.query(
      `UPDATE otp_tokens SET is_used=true WHERE phone_hash=$1 AND purpose=$2 AND is_used=false`,
      [phone_hash, purpose]
    );

    const otp = generateOtp();
    const token_hash = await bcrypt.hash(otp, parseInt(process.env.BCRYPT_ROUNDS_OTP)||8);
    const expires_at = new Date(Date.now() + 2*60*1000).toISOString();

    await db.insert('otp_tokens', { phone_hash, token_hash, purpose, expires_at, ip_address:req.ip });

    // ── ENVOI SMS ─────────────────────────────────────────────
    // ⚠️ REMPLACER par votre vraie API SMS:
    //
    // OPTION A — Orange SMS API:
    // const tkn = await getOrangeToken();
    // await fetch(`${process.env.ORANGE_SMS_API_URL}/outbound/tel:${process.env.ORANGE_SMS_FROM}/requests`, {
    //   method:'POST', headers:{'Authorization':`Bearer ${tkn}`,'Content-Type':'application/json'},
    //   body: JSON.stringify({ outboundSMSMessageRequest:{
    //     address:[`tel:${phoneNorm}`], senderAddress:`tel:${process.env.ORANGE_SMS_FROM}`,
    //     outboundSMSTextMessage:{ message:`BobdoEduc: Votre code OTP est ${otp}. Valable 2 minutes.` }
    //   }})
    // });
    //
    // OPTION B — Twilio:
    // const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    // await twilio.messages.create({ to:phoneNorm, from:process.env.TWILIO_FROM, body:`BobdoEduc OTP: ${otp}` });
    //
    // OPTION C — Africa's Talking (bien supporté en Afrique):
    // const AT = require('africastalking')({ apiKey:process.env.AT_API_KEY, username:process.env.AT_USERNAME });
    // await AT.SMS.send({ to:[phoneNorm], message:`BobdoEduc: ${otp} (2 min)`, from:'BobdoEduc' });

    if (process.env.NODE_ENV !== 'production') console.log(`[DEV] OTP ${phoneNorm}: ${otp}`);

    await logAudit(null, 'send_otp', 'success', req, { phone_hash, purpose });
    res.json({ success:true, message:'Code OTP envoyé par SMS.' });
  } catch(e) {
    console.error('[send-otp]', e);
    res.status(500).json({ error:'Erreur envoi OTP.' });
  }
});

// ── POST /api/auth/verify-otp ─────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, otp, purpose='register' } = req.body;
    if (!phone||!otp) return res.status(400).json({ error:'Données manquantes.' });

    const db = getDatabase();
    const phone_hash = hashPhone(phone.replace(/\s/g,''));

    const tokens = await db.query(
      `SELECT * FROM otp_tokens WHERE phone_hash=$1 AND purpose=$2 AND is_used=false AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [phone_hash, purpose]
    );
    const token = tokens[0];
    if (!token) return res.status(400).json({ error:'OTP invalide ou expiré. Redemandez un code.' });

    if (token.attempts >= 3) return res.status(429).json({ error:'Trop de tentatives. Demandez un nouveau code.' });

    await db.update('otp_tokens', { attempts: token.attempts+1 }, { id:token.id });

    const valid = await bcrypt.compare(otp, token.token_hash);
    if (!valid) return res.status(400).json({ error:'Code incorrect.' });

    await db.update('otp_tokens', { is_used:true }, { id:token.id });

    const verifyToken = jwt.sign({ phone_hash, purpose, verified:true }, process.env.JWT_SECRET, { expiresIn:'30m' });
    res.json({ success:true, verify_token:verifyToken });
  } catch(e) {
    console.error('[verify-otp]', e);
    res.status(500).json({ error:'Erreur vérification OTP.' });
  }
});

// ── POST /api/auth/register ───────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { phone, password, pseudo, verify_token } = req.body;
    if (!phone||!password||!pseudo||!verify_token)
      return res.status(400).json({ error:'Tous les champs sont requis.' });
    if (password.length < 8) return res.status(400).json({ error:'Mot de passe minimum 8 caractères.' });
    if (pseudo.length < 2 || pseudo.length > 30) return res.status(400).json({ error:'Pseudo entre 2 et 30 caractères.' });

    let decoded;
    try { decoded = jwt.verify(verify_token, process.env.JWT_SECRET); }
    catch { return res.status(400).json({ error:'Session OTP expirée. Recommencez l\'inscription.' }); }
    if (!decoded.verified || decoded.purpose !== 'register')
      return res.status(400).json({ error:'Token invalide.' });

    const phoneNorm  = phone.replace(/\s/g,'');
    const phone_hash = hashPhone(phoneNorm);
    if (decoded.phone_hash !== phone_hash)
      return res.status(400).json({ error:'Numéro ne correspond pas au code OTP.' });

    const db = getDatabase();
    const existing = await db.findOne('users', { phone_hash });
    if (existing) return res.status(409).json({ error:'Numéro déjà inscrit.' });

    const existingPs = await db.findOne('users', { pseudo });
    if (existingPs) return res.status(409).json({ error:'Ce pseudo est déjà pris.' });

    const password_hash   = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS_PASSWORD)||12);
    const phone_encrypted = encryptPhone(phoneNorm);

    const user = await db.insert('users', {
      phone_encrypted, phone_hash, pseudo, password_hash,
      is_verified:true, plan:'free', quiz_free_used:0
    });

    const { accessToken, refreshToken } = generateTokens(user.id);
    const rt_hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await db.insert('refresh_tokens', {
      user_id:user.id, token_hash:rt_hash,
      expires_at:new Date(Date.now()+30*24*60*60*1000).toISOString(),
      ip_address:req.ip, user_agent:req.headers['user-agent']
    });

    await logAudit(user.id, 'register', 'success', req);
    res.status(201).json({
      success:true,
      user: { id:user.id, pseudo:user.pseudo, plan:user.plan, quiz_free_used:0, quiz_free_remaining: parseInt(process.env.FREE_QUIZ_LIMIT)||20 },
      access_token:accessToken, refresh_token:refreshToken
    });
  } catch(e) {
    console.error('[register]', e);
    res.status(500).json({ error:'Erreur inscription.' });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { phone, password } = req.body;
    if (!phone||!password) return res.status(400).json({ error:'Données manquantes.' });

    const db = getDatabase();
    const phone_hash = hashPhone(phone.replace(/\s/g,''));
    const user = await db.findOne('users', { phone_hash });

    if (!user) {
      await logAudit(null,'login','failed',req,{reason:'not_found'});
      return res.status(401).json({ error:'Numéro ou mot de passe incorrect.' });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const rem = Math.ceil((new Date(user.locked_until)-new Date())/60000);
      return res.status(423).json({ error:`Compte bloqué. Réessayez dans ${rem} minutes.` });
    }
    if (user.is_banned) return res.status(403).json({ error:'Compte suspendu. Contactez le support.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const att = (user.failed_login_attempts||0)+1;
      const upd = { failed_login_attempts:att };
      if (att >= 5) upd.locked_until = new Date(Date.now()+30*60*1000).toISOString();
      await db.update('users', upd, { id:user.id });
      await logAudit(user.id,'login','failed',req,{attempts:att});
      return res.status(401).json({ error:'Numéro ou mot de passe incorrect.' });
    }

    await db.update('users', { failed_login_attempts:0, locked_until:null, last_login:new Date().toISOString() }, { id:user.id });

    const { accessToken, refreshToken } = generateTokens(user.id);
    const rt_hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await db.insert('refresh_tokens', {
      user_id:user.id, token_hash:rt_hash,
      expires_at:new Date(Date.now()+30*24*60*60*1000).toISOString(),
      ip_address:req.ip, user_agent:req.headers['user-agent']
    });

    const FREE_LIMIT = parseInt(process.env.FREE_QUIZ_LIMIT)||20;
    const isPremium  = user.plan !== 'free' && user.subscription_end && new Date(user.subscription_end) > new Date();

    await logAudit(user.id,'login','success',req);
    res.json({
      success:true,
      user:{
        id:user.id, pseudo:user.pseudo, plan:user.plan,
        is_premium:isPremium,
        quiz_free_used: user.quiz_free_used||0,
        quiz_free_remaining: Math.max(0, FREE_LIMIT-(user.quiz_free_used||0)),
        subscription_end: user.subscription_end,
        total_correct:user.total_correct||0, total_wrong:user.total_wrong||0,
        total_sessions:user.total_sessions||0
      },
      access_token:accessToken, refresh_token:refreshToken
    });
  } catch(e) {
    console.error('[login]', e);
    res.status(500).json({ error:'Erreur connexion.' });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error:'Refresh token requis.' });

    const db = getDatabase();
    const rt_hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
    const tokens = await db.query(
      `SELECT * FROM refresh_tokens WHERE token_hash=$1 AND is_revoked=false AND expires_at > NOW() LIMIT 1`,
      [rt_hash]
    );
    const token = tokens[0];
    if (!token) return res.status(401).json({ error:'Token invalide ou expiré.' });

    await db.update('refresh_tokens', { is_revoked:true }, { id:token.id });

    const { accessToken, refreshToken:newRt } = generateTokens(token.user_id);
    const new_rt_hash = crypto.createHash('sha256').update(newRt).digest('hex');
    await db.insert('refresh_tokens', {
      user_id:token.user_id, token_hash:new_rt_hash,
      expires_at:new Date(Date.now()+30*24*60*60*1000).toISOString(),
      ip_address:req.ip, user_agent:req.headers['user-agent']
    });
    res.json({ access_token:accessToken, refresh_token:newRt });
  } catch(e) {
    res.status(500).json({ error:'Erreur renouvellement.' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (refresh_token) {
      const db = getDatabase();
      const rt_hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
      await db.update('refresh_tokens', { is_revoked:true }, { token_hash:rt_hash });
    }
    res.json({ success:true });
  } catch(e) { res.status(500).json({ error:'Erreur déconnexion.' }); }
});

// ── POST /api/auth/forgot-password ───────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error:'Numéro requis.' });
    const db = getDatabase();
    const phone_hash = hashPhone(phone.replace(/\s/g,''));
    const user = await db.findOne('users', { phone_hash });
    // Même réponse que l'user existe ou non (sécurité)
    if (user) {
      // Déclencher le même flow que send-otp avec purpose='reset_password'
      // (Appel interne ou logique dupliquée)
    }
    res.json({ success:true, message:'Si ce numéro est enregistré, un code a été envoyé.' });
  } catch(e) { res.status(500).json({ error:'Erreur.' }); }
});

module.exports = router;
