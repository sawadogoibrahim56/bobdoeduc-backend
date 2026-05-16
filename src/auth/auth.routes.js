// ============================================================
// src/auth/auth.routes.js — BobdoEduc VERSION FINALE
// ============================================================
'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { getDatabase }            = require('../config/database');
const { sendEmail, templateOTP } = require('../config/mailer');

const router = express.Router();

const hashPhone = p => crypto.createHash('sha256').update(p.replace(/\s/g,'')).digest('hex');
const hashEmail = e => crypto.createHash('sha256').update(e.toLowerCase().trim()).digest('hex');

function encryptData(data) {
  const keyHex = process.env.ENCRYPTION_KEY || 'default_key';
  const keyBuf = keyHex.length >= 64
    ? Buffer.from(keyHex.slice(0,64), 'hex')
    : crypto.createHash('sha256').update(keyHex).digest();
  const iv     = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', keyBuf, iv);
  return iv.toString('hex') + ':' + Buffer.concat([cipher.update(data), cipher.final()]).toString('hex');
}

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateTokens(userId) {
  const at = jwt.sign(
    { sub: userId, type: 'access' },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '15m' }
  );
  return { accessToken: at, refreshToken: crypto.randomBytes(64).toString('hex') };
}

async function logAudit(userId, action, status, req, meta) {
  try {
    await getDatabase().insert('audit_logs', {
      user_id:    userId || null,
      action,     status,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      metadata:   JSON.stringify(meta || {})
    });
  } catch(e) { /* silent */ }
}

// ── POST /api/auth/send-otp ───────────────────────────────────router.post('/send-otp', async function(req, res) {
  try {
    var phone   = req.body.phone;
    var email   = req.body.email;
    var purpose = req.body.purpose || 'register';

    if (!email && !phone)
      return res.status(400).json({ error: 'Email ou numéro de téléphone requis.' });

    var db = getDatabase();
    var identifier_hash, contact_type, contact_display, send_to;

    if (email) {
      var emailNorm = email.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm))
        return res.status(400).json({ error: 'Adresse email invalide.' });
      identifier_hash = hashEmail(emailNorm);
      contact_type    = 'email';
      contact_display = emailNorm.replace(/(.{2}).*(@.*)/, '$1***$2');
      send_to         = emailNorm;
      if (purpose === 'register') {
        var existEmail = await db.findOne('users', { email_hash: identifier_hash });
        if (existEmail) return res.status(409).json({ error: 'Cet email est déjà inscrit.' });
      }
    } else {
      var phoneNorm = phone.replace(/\s/g, '');
      if (!/^\+?[0-9]{8,15}$/.test(phoneNorm))
        return res.status(400).json({ error: 'Numéro invalide (8-15 chiffres).' });
      identifier_hash = hashPhone(phoneNorm);
      contact_type    = 'phone';
      contact_display = phoneNorm.slice(0,4) + '****' + phoneNorm.slice(-2);
      if (purpose === 'register') {
        var existPhone = await db.findOne('users', { phone_hash: identifier_hash });
        if (existPhone) return res.status(409).json({ error: 'Ce numéro est déjà inscrit.' });
      }
    }

    await db.query(
      'UPDATE otp_tokens SET is_used=true WHERE phone_hash=$1 AND purpose=$2 AND is_used=false',
      [identifier_hash, purpose]
    );

    var otp        = generateOtp();
    var token_hash = await bcrypt.hash(otp, parseInt(process.env.BCRYPT_ROUNDS_OTP) || 8);
    var expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await db.insert('otp_tokens', {
      phone_hash: identifier_hash,
      token_hash: token_hash,
      purpose:    purpose,
      expires_at: expires_at,
      ip_address: req.ip
    });

    if (contact_type === 'email' && send_to) {
      var tpl    = templateOTP(otp, purpose);
      var result = await sendEmail({ to: send_to, subject: tpl.subject, html: tpl.html });
      if (!result.success) console.warn('[send-otp] Email échoué, OTP logs:', otp);
    } else {
      console.log('[OTP SMS] ' + contact_display + ': ' + otp);
    }

    console.log('[OTP GENERATED] ' + contact_display + ' | purpose=' + purpose + ' | otp=' + otp);
    await logAudit(null, 'send_otp', 'success', req, { contact_type: contact_type, purpose: purpose });

    return res.json({
      success:      true,
      message:      contact_type === 'email' ? 'Code envoyé à ' + contact_display : 'Code généré pour ' + contact_display,
      contact_type: contact_type
    });

  } catch(e) {
    console.error('[send-otp]', e.message);
    return res.status(500).json({ error: 'Erreur envoi OTP: ' + e.message });
  }
});

// ── POST /api/auth/verify-otp ─────────────────────────────────
router.post('/verify-otp', async function(req, res) {
  try {
    var phone   = req.body.phone;
    var email   = req.body.email;
    var otp     = req.body.otp;
    var purpose = req.body.purpose || 'register';

    if (!otp || (!phone && !email))
      return res.status(400).json({ error: 'Code OTP et contact requis.' });

    var db              = getDatabase();
    var identifier_hash = email
      ? hashEmail(email.toLowerCase().trim())
      : hashPhone(phone.replace(/\s/g, ''));

    var tokens = await db.query(
      'SELECT * FROM otp_tokens WHERE phone_hash=$1 AND purpose=$2 AND is_used=false AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1',
      [identifier_hash, purpose]
    );
    var token = tokens[0];

    if (!token)
      return res.status(400).json({ error: 'Code invalide ou expiré. Cliquez Renvoyer.' });
    if (token.attempts >= 5)
      return res.status(429).json({ error: 'Trop de tentatives. Demandez un nouveau code.' });

    await db.query('UPDATE otp_tokens SET attempts = attempts + 1 WHERE id = $1', [token.id]);

    var valid = await bcrypt.compare(otp.toString(), token.token_hash);
    if (!valid)
      return res.status(400).json({ error: 'Code incorrect. Vérifiez et réessayez.' });

    await db.query('UPDATE otp_tokens SET is_used=true WHERE id=$1', [token.id]);

    var verifyToken = jwt.sign(
      { identifier_hash: identifier_hash, purpose: purpose, verified: true, contact_type: email ? 'email' : 'phone' },
      process.env.JWT_SECRET,
      { expiresIn: '30m' }
    );

    return res.json({ success: true, verify_token: verifyToken });

  } catch(e) {
    console.error('[verify-otp]', e.message);
    return res.status(500).json({ error: 'Erreur vérification OTP.' });
  }
});

// ── POST /api/auth/register ───────────────────────────────────
router.post('/register', async function(req, res) {
  try {
    var phone        = req.body.phone;
    var email        = req.body.email;
    var password     = req.body.password;
    var pseudo       = req.body.pseudo;
    var verify_token = req.body.verify_token;

    if (!password || !pseudo || !verify_token)
      return res.status(400).json({ error: 'Pseudo, mot de passe et token OTP requis.' });
    if (!phone && !email)
      return res.status(400).json({ error: 'Email ou téléphone requis.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Mot de passe minimum 8 caractères.' });
    if (pseudo.length < 2 || pseudo.length > 30)
      return res.status(400).json({ error: 'Pseudo entre 2 et 30 caractères.' });

    var decoded;
    try {
      decoded = jwt.verify(verify_token, process.env.JWT_SECRET);
    } catch(e) {
      return res.status(400).json({ error: 'Session expirée. Recommencez depuis le début.' });
    }
    if (!decoded.verified || decoded.purpose !== 'register')
      return res.status(400).json({ error: 'Token invalide.' });

    var db = getDatabase();

    var existPs = await db.findOne('users', { pseudo: pseudo });
    if (existPs) return res.status(409).json({ error: 'Ce pseudo est déjà pris. Choisissez-en un autre.' });

    var userData = {};

    if (decoded.contact_type === 'email' && email) {
      var email_hash = hashEmail(email.toLowerCase().trim());
      if (decoded.identifier_hash !== email_hash)
        return res.status(400).json({ error: 'Email ne correspond pas au code OTP.' });
      var existEmail = await db.findOne('users', { email_hash: email_hash });
      if (existEmail) return res.status(409).json({ error: 'Cet email est déjà inscrit.' });
      userData.email_hash      = email_hash;
      userData.email_encrypted = encryptData(email.toLowerCase().trim());
    } else if (decoded.contact_type === 'phone' && phone) {
      var phoneNorm  = phone.replace(/\s/g, '');
      var phone_hash = hashPhone(phoneNorm);
      if (decoded.identifier_hash !== phone_hash)
        return res.status(400).json({ error: 'Numéro ne correspond pas au code OTP.' });
      var existPhone = await db.findOne('users', { phone_hash: phone_hash });
      if (existPhone) return res.status(409).json({ error: 'Ce numéro est déjà inscrit.' });
      userData.phone_hash      = phone_hash;
      userData.phone_encrypted = encryptData(phoneNorm);
      userData.phone_display   = phoneNorm.slice(0,4) + '****' + phoneNorm.slice(-2);
    } else {
      return res.status(400).json({ error: 'Contact invalide.' });
    }

    var password_hash = await bcrypt.hash(password, parseInt(process.env.BCRYPT_ROUNDS_PASSWORD) || 12);
    userData.pseudo        = pseudo;
    userData.password_hash = password_hash;
    userData.is_verified   = true;
    userData.plan          = 'free';
    userData.quiz_free_used = 0;

    var user = await db.insert('users', userData);

    var tokens    = generateTokens(user.id);
    var rt_hash   = crypto.createHash('sha256').update(tokens.refreshToken).digest('hex');
    await db.insert('refresh_tokens', {
      user_id:    user.id,
      token_hash: rt_hash,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      ip_address: req.ip,
      user_agent: req.headers['user-agent']
    });

    await logAudit(user.id, 'register', 'success', req);

    var FREE_LIMIT = parseInt(process.env.FREE_QUIZ_LIMIT) || 20;
    return res.status(201).json({
      success: true,
      user: {
        id: user.id, pseudo: user.pseudo, plan: user.plan,
        quiz_free_used: 0, quiz_free_remaining: FREE_LIMIT
      },
      access_token:  tokens.accessToken,
      refresh_token: tokens.refreshToken
    });

  } catch(e) {
    console.error('[register]', e.message);
    return res.status(500).json({ error: 'Erreur inscription: ' + e.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', async function(req, res) {
  try {
    var phone    = req.body.phone;
    var email    = req.body.email;
    var password = req.body.password;

    if (!password || (!phone && !email))
      return res.status(400).json({ error: 'Email/téléphone et mot de passe requis.' });

    var db   = getDatabase();
    var user = null;

    if (email) {
      user = await db.findOne('users', { email_hash: hashEmail(email.toLowerCase().trim()) });
    } else {
      user = await db.findOne('users', { phone_hash: hashPhone(phone.replace(/\s/g,'')) });
    }

    if (!user) {
      await logAudit(null, 'login', 'failed', req, { reason: 'not_found' });
      return res.status(401).json({ error: 'Identifiant ou mot de passe incorrect.' });
    }
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      var rem = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      return res.status(423).json({ error: 'Compte bloqué. Réessayez dans ' + rem + ' minutes.' });
    }
    if (user.is_banned)
      return res.status(403).json({ error: 'Compte suspendu. Contactez le support.' });

    var valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      var att = (user.failed_login_attempts || 0) + 1;
      var upd = { failed_login_attempts: att };
      if (att >= 5) upd.locked_until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await db.update('users', upd, { id: user.id });
      await logAudit(user.id, 'login', 'failed', req, { attempts: att });
      return res.status(401).json({
        error: att >= 5 ? 'Trop de tentatives. Compte bloqué 30 minutes.' : 'Mot de passe incorrect.'
      });
    }

    await db.update('users', { failed_login_attempts: 0, locked_until: null, last_login: new Date().toISOString() }, { id: user.id });

    var tokens2  = generateTokens(user.id);
    var rt_hash2 = crypto.createHash('sha256').update(tokens2.refreshToken).digest('hex');
    await db.insert('refresh_tokens', {
      user_id:    user.id,
      token_hash: rt_hash2,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      ip_address: req.ip,
      user_agent: req.headers['user-agent']
    });

    var FREE_LIMIT2 = parseInt(process.env.FREE_QUIZ_LIMIT) || 20;
    var isPremium   = user.plan !== 'free' && user.subscription_end && new Date(user.subscription_end) > new Date();
    await logAudit(user.id, 'login', 'success', req);

    return res.json({
      success: true,
      user: {
        id:                  user.id,
        pseudo:              user.pseudo,
        plan:                user.plan,
        is_premium:          isPremium,
        subscription_end:    user.subscription_end || null,
        quiz_free_used:      user.quiz_free_used      || 0,
        quiz_free_remaining: Math.max(0, FREE_LIMIT2 - (user.quiz_free_used || 0)),
        total_correct:       user.total_correct   || 0,
        total_wrong:         user.total_wrong     || 0,
        total_sessions:      user.total_sessions  || 0,
        total_score:         user.total_score     || 0
      },
      access_token:  tokens2.accessToken,
      refresh_token: tokens2.refreshToken
    });

  } catch(e) {
    console.error('[login]', e.message);
    return res.status(500).json({ error: 'Erreur connexion: ' + e.message });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────router.post('/refresh', async function(req, res) {
  try {
    var refresh_token = req.body.refresh_token;
    if (!refresh_token) return res.status(400).json({ error: 'Refresh token requis.' });

    var db      = getDatabase();
    var rt_hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
    var rows    = await db.query(
      'SELECT * FROM refresh_tokens WHERE token_hash=$1 AND is_revoked=false AND expires_at > NOW() LIMIT 1',
      [rt_hash]
    );
    var token = rows[0];
    if (!token) return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.' });

    await db.update('refresh_tokens', { is_revoked: true }, { id: token.id });

    var newTokens  = generateTokens(token.user_id);
    var new_hash   = crypto.createHash('sha256').update(newTokens.refreshToken).digest('hex');
    await db.insert('refresh_tokens', {
      user_id:    token.user_id,
      token_hash: new_hash,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      ip_address: req.ip,
      user_agent: req.headers['user-agent']
    });

    return res.json({ access_token: newTokens.accessToken, refresh_token: newTokens.refreshToken });

  } catch(e) {
    console.error('[refresh]', e.message);
    return res.status(500).json({ error: 'Erreur renouvellement.' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────
router.post('/logout', async function(req, res) {
  try {
    var refresh_token = req.body.refresh_token;
    if (refresh_token) {
      var rt_hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
      await getDatabase().update('refresh_tokens', { is_revoked: true }, { token_hash: rt_hash });
    }
    return res.json({ success: true });
  } catch(e) {
    return res.status(500).json({ error: 'Erreur déconnexion.' });
  }
});

// ── POST /api/auth/forgot-password ───────────────────────────
router.post('/forgot-password', async function(req, res) {
  try {
    var phone   = req.body.phone;
    var email   = req.body.email;
    if (!phone && !email)
      return res.status(400).json({ error: 'Email ou téléphone requis.' });

    var db   = getDatabase();
    var user = null;
    if (email) {
      user = await db.findOne('users', { email_hash: hashEmail(email.toLowerCase().trim()) });
    } else {
      user = await db.findOne('users', { phone_hash: hashPhone(phone.replace(/\s/g,'')) });
    }

    if (user) {
      var otp2            = generateOtp();
      var token_hash2     = await bcrypt.hash(otp2, 8);
      var identifier_hash2 = email
        ? hashEmail(email.toLowerCase().trim())
        : hashPhone(phone.replace(/\s/g,''));

      await db.query(
        "UPDATE otp_tokens SET is_used=true WHERE phone_hash=$1 AND purpose='reset_password' AND is_used=false",
        [identifier_hash2]
      );
      await db.insert('otp_tokens', {
        phone_hash: identifier_hash2,
        token_hash: token_hash2,
        purpose:    'reset_password',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        ip_address: req.ip
      });

      if (email) {
        var tpl2 = templateOTP(otp2, 'reset_password');
        await sendEmail({ to: email.toLowerCase().trim(), subject: tpl2.subject, html: tpl2.html });
      } else {
        console.log('[RESET OTP] ' + phone + ': ' + otp2);
      }
      console.log('[RESET OTP GENERATED] otp=' + otp2);
    }

    return res.json({ success: true, message: 'Si ce contact est enregistré, vous recevrez un code.' });

  } catch(e) {
    console.error('[forgot-password]', e.message);
    return res.status(500).json({ error: 'Erreur réinitialisation.' });
  }
});

// ── POST /api/auth/reset-password ────────────────────────────
router.post('/reset-password', async function(req, res) {
  try {
    var phone        = req.body.phone;
    var email        = req.body.email;
    var new_password = req.body.new_password;
    var verify_token = req.body.verify_token;

    if (!new_password || new_password.length < 8)
      return res.status(400).json({ error: 'Nouveau mot de passe minimum 8 caractères.' });
    if (!phone && !email)
      return res.status(400).json({ error: 'Email ou téléphone requis.' });

    var decoded2;
    try {
      decoded2 = jwt.verify(verify_token, process.env.JWT_SECRET);
    } catch(e) {
      return res.status(400).json({ error: 'Session expirée. Recommencez.' });
    }
    if (!decoded2.verified || decoded2.purpose !== 'reset_password')
      return res.status(400).json({ error: 'Token invalide.' });

    var db2  = getDatabase();
    var user2 = null;
    if (email) {
      user2 = await db2.findOne('users', { email_hash: hashEmail(email.toLowerCase().trim()) });
    } else {
      user2 = await db2.findOne('users', { phone_hash: hashPhone(phone.replace(/\s/g,'')) });
    }

    if (!user2)
      return res.status(404).json({ error: 'Compte introuvable.' });

    var new_hash2 = await bcrypt.hash(new_password, parseInt(process.env.BCRYPT_ROUNDS_PASSWORD) || 12);
    await db2.update('users', { password_hash: new_hash2, failed_login_attempts: 0, locked_until: null }, { id: user2.id });
    await db2.query('UPDATE refresh_tokens SET is_revoked=true WHERE user_id=$1', [user2.id]);
    await logAudit(user2.id, 'password_reset', 'success', req);

    return res.json({ success: true, message: 'Mot de passe réinitialisé. Connectez-vous.' });

  } catch(e) {
    console.error('[reset-password]', e.message);
    return res.status(500).json({ error: 'Erreur réinitialisation: ' + e.message });
  }
});

module.exports = router;
