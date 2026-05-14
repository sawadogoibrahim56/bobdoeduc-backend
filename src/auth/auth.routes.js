// ============================================================
// src/auth/auth.routes.js — BobdoEduc Audité 
// ============================================================
'use strict';
const express  = require('express');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { getDatabase }           = require('../config/database');
const { sendEmail, templateOTP } = require('../config/mailer');

const router = express.Router();

// ── Utilitaires ───────────────────────────────────────────────
const hashPhone = p => crypto.createHash('sha256').update(p.replace(/\s/g,'')).digest('hex');
const hashEmail = e => crypto.createHash('sha256').update(e.toLowerCase().trim()).digest('hex');

function encryptData(data) {
  const keyHex = process.env.ENCRYPTION_KEY || 'default';
  const keyBuf = keyHex.length >= 64
    ? Buffer.from(keyHex.slice(0,64), 'hex')
    : crypto.createHash('sha256').update(keyHex).digest();
  const iv = crypto.randomBytes(16);
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

async function logAudit(userId, action, status, req, meta = {}) {
  try {
    await getDatabase().insert('audit_logs', {
      user_id: userId || null, action, status,
      ip_address: req.ip,
      user_agent: req.headers['user-agent'],
      metadata: JSON.stringify(meta)
    });
  } catch(e) {}
}

// ── POST /api/auth/send-otp ───────────────────────────────────
router.post('/send-otp', async (req, res) => {
  try {
    const { phone, email, purpose = 'register' } = req.body;
    if (!email && !phone)
      return res.status(400).json({ error: 'Email ou numéro de téléphone requis.' });

    const db = getDatabase();
    let identifier_hash, contact_type, contact_display, send_to;

    if (email) {
      const emailNorm = email.toLowerCase().trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailNorm))
        return res.status(400).json({ error: 'Adresse email invalide.' });

      identifier_hash = hashEmail(emailNorm);
      contact_type    = 'email';
      contact_display = emailNorm.replace(/(.{2}).*(@.*)/, '$1***$2');
      send_to         = emailNorm;

      if (purpose === 'register') {
        const existing = await db.findOne('users', { email_hash: identifier_hash });
        if (existing) return res.status(409).json({ error: 'Cet email est déjà inscrit.' });
      }
    } else {
      const phoneNorm = phone.replace(/\s/g, '');
      if (!/^\+?[0-9]{8,15}$/.test(phoneNorm))
        return res.status(400).json({ error: 'Numéro de téléphone invalide (8-15 chiffres).' });

      identifier_hash = hashPhone(phoneNorm);
      contact_type    = 'phone';
      contact_display = phoneNorm.slice(0,4) + '****' + phoneNorm.slice(-2);

      if (purpose === 'register') {
        const existing = await db.findOne('users', { phone_hash: identifier_hash });
        if (existing) return res.status(409).json({ error: 'Ce numéro est déjà inscrit.' });
      }
    }

    // Invalider anciens OTP
    await db.query(
      `UPDATE otp_tokens SET is_used=true WHERE phone_hash=$1 AND purpose=$2 AND is_used=false`,
      [identifier_hash, purpose]
    );

    const otp        = generateOtp();
    const token_hash = await bcrypt.hash(otp, parseInt(process.env.BCRYPT_ROUNDS_OTP) || 8);
    const expires_at = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    await db.insert('otp_tokens', {
      phone_hash: identifier_hash,
      token_hash, purpose, expires_at,
      ip_address: req.ip
    });

    // Envoi email ou log SMS
    if (contact_type === 'email' && send_to) {
      const tpl = templateOTP(otp, purpose);
      const result = await sendEmail({ to: send_to, ...tpl });
      if (!result.success) {
        console.warn('[send-otp] Email échoué, OTP dans logs:', otp);
      }
    } else {
      // SMS: afficher dans logs (à intégrer avec une API SMS)
      console.log(`[OTP SMS] Envoyer au ${contact_display}: ${otp}`);
    }

    // Toujours afficher l'OTP dans les logs Render pour debug
    console.log(`[OTP GENERATED] ${contact_display} | purpose=${purpose} | otp=${otp}`);

    await logAudit(null, 'send_otp', 'success', req, { contact_type, purpose });

    res.json({
      success: true,
      message: contact_type === 'email'
        ? `Code envoyé à ${contact_display}`
        : `Code généré pour ${contact_display} (voir logs)`,
      contact_type,
      // En DEV uniquement — retirer en prod si souhaité
      ...(process.env.NODE_ENV !== 'production' && { dev_otp: otp })
    });

  } catch(e) {
    console.error('[send-otp]', e.message);
    res.status(500).json({ error: 'Erreur envoi OTP: ' + e.message });
  }
});

// ── POST /api/auth/verify-otp ─────────────────────────────────
router.post('/verify-otp', async (req, res) => {
  try {
    const { phone, email, otp, purpose = 'register' } = req.body;
    if (!otp || (!phone && !email))
      return res.status(400).json({ error: 'Code OTP et contact requis.' });

    const db = getDatabase();
    const identifier_hash = email
      ? hashEmail(email.toLowerCase().trim())
      : hashPhone(phone.replace(/\s/g, ''));

    const tokens = await db.query(
      `SELECT * FROM otp_tokens
       WHERE phone_hash=$1 AND purpose=$2 AND is_used=false AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [identifier_hash, purpose]
    );
    const token = tokens[0];
    if (!token)
      return res.status(400).json({ error: 'Code invalide ou expiré. Cliquez "Renvoyer" pour un nouveau code.' });

    if (token.attempts >= 5)
      return res.status(429).json({ error: 'Trop de tentatives. Demandez un nouveau code.' });

    await db.query(
      `UPDATE otp_tokens SET attempts = attempts + 1 WHERE id = $1`,
      [token.id]
    );

    const valid = await bcrypt.compare(otp.toString(), token.token_hash);
    if (!valid)
      return res.status(400).json({ error: 'Code incorrect. Vérifiez et réessayez.' });

    await db.query(`UPDATE otp_tokens SET is_used=true WHERE id=$1`, [token.id]);

    const verifyToken = jwt.sign(
      {
        identifier_hash, purpose, verified: true,
        contact_type: email ? 'email' : 'phone'
      },
      process.env.JWT_SECRET,
      { expiresIn: '30m' }
    );

    res.json({ success: true, verify_token: verifyToken });

  } catch(e) {
    console.error('[verify-otp]', e.message);
    res.status(500).json({ error: 'Erreur vérification OTP.' });
  }
});

// ── POST /api/auth/register ───────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { phone, email, password, pseudo, verify_token } = req.body;

    if (!password || !pseudo || !verify_token)
      return res.status(400).json({ error: 'Pseudo, mot de passe et token OTP requis.' });
    if (!phone && !email)
      return res.status(400).json({ error: 'Email ou téléphone requis.' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Mot de passe minimum 8 caractères.' });
    if (pseudo.length < 2 || pseudo.length > 30)
      return res.status(400).json({ error: 'Pseudo entre 2 et 30 caractères.' });

    // Vérifier le token OTP
    let decoded;
    try {
      decoded = jwt.verify(verify_token, process.env.JWT_SECRET);
    } catch(e) {
      return res.status(400).json({ error: 'Session expirée. Recommencez depuis le début.' });
    }
    if (!decoded.verified || decoded.purpose !== 'register')
      return res.status(400).json({ error: 'Token invalide.' });

    const db = getDatabase();

    // Vérifier pseudo unique
    const existPs = await db.findOne('users', { pseudo });
    if (existPs) return res.status(409).json({ error: 'Ce pseudo est déjà pris. Choisissez-en un autre.' });

    let userData = {};

    if (decoded.contact_type === 'email' && email) {
      const email_hash = hashEmail(email.toLowerCase().trim());
      if (decoded.identifier_hash !== email_hash)
        return res.status(400).json({ error: 'Email ne correspond pas au code OTP.' });
      const existing = await db.findOne('users', { email_hash });
      if (existing) return res.status(409).json({ error: 'Cet email est déjà inscrit.' });
      userData.email_hash      = email_hash;
      userData.email_encrypted = encryptData(email.toLowerCase().trim());

    } else if (decoded.contact_type === 'phone' && phone) {
      const phoneNorm  = phone.replace(/\s/g, '');
      const phone_hash = hashPhone(phoneNorm);
      if (decoded.identifier_hash !== phone_hash)
        return res.status(400).json({ error: 'Numéro ne correspond pas au code OTP.' });
      const existing = await db.findOne('users', { phone_hash });
      if (existing) return res.status(409).json({ error: 'Ce numéro est déjà inscrit.' });
      userData.phone_hash      = phone_hash;
      userData.phone_encrypted = encryptData(phoneNorm);
      userData.phone_display   = phoneNorm.slice(0,4) + '****' + phoneNorm.slice(-2);
    } else {
      return res.status(400).json({ error: 'Contact invalide.' });
    }

    const password_hash = await bcrypt.hash(
      password,
      parseInt(process.env.BCRYPT_ROUNDS_PASSWORD) || 12
    );

    const user = await db.insert('users', {
      ...userData, pseudo, password_hash,
      is_verified: true, plan: 'free', quiz_free_used: 0
    });
  const { accessToken, refreshToken } = generateTokens(user.id);
    const rt_hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await db.insert('refresh_tokens', {
      user_id:    user.id,
      token_hash: rt_hash,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      ip_address: req.ip,
      user_agent: req.headers['user-agent']
    });

    await logAudit(user.id, 'register', 'success', req);

    const FREE_LIMIT = parseInt(process.env.FREE_QUIZ_LIMIT) || 20;
    res.status(201).json({
      success: true,
      user: {
        id: user.id, pseudo: user.pseudo, plan: user.plan,
        quiz_free_used: 0, quiz_free_remaining: FREE_LIMIT
      },
      access_token:  accessToken,
      refresh_token: refreshToken
    });

  } catch(e) {
    console.error('[register]', e.message);
    res.status(500).json({ error: 'Erreur inscription: ' + e.message });
  }
});

// ── POST /api/auth/login ──────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { phone, email, password } = req.body;
    if (!password || (!phone && !email))
      return res.status(400).json({ error: 'Email/téléphone et mot de passe requis.' });

    const db = getDatabase();
    let user;

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
      const rem = Math.ceil((new Date(user.locked_until) - Date.now()) / 60000);
      return res.status(423).json({ error: `Compte temporairement bloqué. Réessayez dans ${rem} minutes.` });
    }

    if (user.is_banned)
      return res.status(403).json({ error: 'Compte suspendu. Contactez le support.' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      const att = (user.failed_login_attempts || 0) + 1;
      const upd = { failed_login_attempts: att };
      if (att >= 5) upd.locked_until = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      await db.update('users', upd, { id: user.id });
      await logAudit(user.id, 'login', 'failed', req, { attempts: att });
      return res.status(401).json({
        error: att >= 5
          ? 'Trop de tentatives. Compte bloqué 30 minutes.'
          : 'Mot de passe incorrect.'
      });
    }

    await db.update('users', {
      failed_login_attempts: 0,
      locked_until: null,
      last_login: new Date().toISOString()
    }, { id: user.id });

    const { accessToken, refreshToken } = generateTokens(user.id);
    const rt_hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    await db.insert('refresh_tokens', {
      user_id:    user.id,
      token_hash: rt_hash,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      ip_address: req.ip,
      user_agent: req.headers['user-agent']
    });

    const FREE_LIMIT = parseInt(process.env.FREE_QUIZ_LIMIT) || 20;
    const isPremium  = user.plan !== 'free'
      && user.subscription_end
      && new Date(user.subscription_end) > new Date();

    await logAudit(user.id, 'login', 'success', req);

    res.json({
      success: true,
      user: {
        id:                  user.id,
        pseudo:              user.pseudo,
        plan:                user.plan,
        is_premium:          isPremium,
        subscription_end:    user.subscription_end || null,
        quiz_free_used:      user.quiz_free_used      || 0,
        quiz_free_remaining: Math.max(0, FREE_LIMIT - (user.quiz_free_used || 0)),
        total_correct:       user.total_correct   || 0,
        total_wrong:         user.total_wrong     || 0,
        total_sessions:      user.total_sessions  || 0,
        total_score:         user.total_score     || 0
      },
      access_token:  accessToken,
      refresh_token: refreshToken
    });

  } catch(e) {
    console.error('[login]', e.message);
    res.status(500).json({ error: 'Erreur connexion: ' + e.message });
  }
});

// ── POST /api/auth/refresh ────────────────────────────────────
router.post('/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (!refresh_token) return res.status(400).json({ error: 'Refresh token requis.' });

    const db      = getDatabase();
    const rt_hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
    const rows    = await db.query(
      `SELECT * FROM refresh_tokens WHERE token_hash=$1 AND is_revoked=false AND expires_at > NOW() LIMIT 1`,
      [rt_hash]
    );
    const token = rows[0];
    if (!token) return res.status(401).json({ error: 'Session expirée. Reconnectez-vous.' });

    await db.update('refresh_tokens', { is_revoked: true }, { id: token.id });

    const { accessToken, refreshToken: newRt } = generateTokens(token.user_id);
    const new_hash = crypto.createHash('sha256').update(newRt).digest('hex');
    await db.insert('refresh_tokens', {
      user_id:    token.user_id,
      token_hash: new_hash,
      expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      ip_address: req.ip,
      user_agent: req.headers['user-agent']
    });

    res.json({ access_token: accessToken, refresh_token: newRt });

  } catch(e) {
    console.error('[refresh]', e.message);
    res.status(500).json({ error: 'Erreur renouvellement.' });
  }
});

// ── POST /api/auth/logout ─────────────────────────────────────
router.post('/logout', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    if (refresh_token) {
      const rt_hash = crypto.createHash('sha256').update(refresh_token).digest('hex');
      await getDatabase().update('refresh_tokens', { is_revoked: true }, { token_hash: rt_hash });
    }
    res.json({ success: true });
  } catch(e) {
    res.status(500).json({ error: 'Erreur déconnexion.' });
  }
});

// ── POST /api/auth/forgot-password ───────────────────────────
router.post('/forgot-password', async (req, res) => {
  try {
    const { phone, email } = req.body;
    if (!phone && !email)
      return res.status(400).json({ error: 'Email ou téléphone requis.' });

    const db = getDatabase();
    let user;
    if (email) {
      user = await db.findOne('users', { email_hash: hashEmail(email.toLowerCase().trim()) });
    } else {
      user = await db.findOne('users', { phone_hash: hashPhone(phone.replace(/\s/g,'')) });
    }

    if (user) {
      const otp            = generateOtp();
      const token_hash     = await bcrypt.hash(otp, 8);
      const identifier_hash = email
        ? hashEmail(email.toLowerCase().trim())
        : hashPhone(phone.replace(/\s/g,''));

      await db.query(
        `UPDATE otp_tokens SET is_used=true WHERE phone_hash=$1 AND purpose='reset_password' AND is_used=false`,
        [identifier_hash]
      );
      await db.insert('otp_tokens', {
        phone_hash: identifier_hash, token_hash,
        purpose: 'reset_password',
        expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        ip_address: req.ip
      });

      if (email) {
        const tpl = templateOTP(otp, 'reset_password');
        await sendEmail({ to: email.toLowerCase().trim(), ...tpl });
      } else {
        console.log(`[RESET OTP] ${phone}: ${otp}`);
      }
      console.log(`[RESET OTP GENERATED] otp=${otp}`);
    }

    // Même réponse que l'utilisateur existe ou non (sécurité)
    res.json({
      success: true,
      message: 'Si ce contact est enregistré, vous recevrez un code. Vérifiez aussi vos logs.'
    });

  } catch(e) {
    console.error('[forgot-password]', e.message);
    res.status(500).json({ error: 'Erreur réinitialisation.' });
  }
});

module.exports = router;
