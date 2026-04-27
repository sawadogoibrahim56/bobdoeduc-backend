// ============================================================
// src/guards/auth.middleware.js
// ============================================================
const jwt = require('jsonwebtoken');
const { getDatabase } = require('../config/database');

async function authMiddleware(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return res.status(401).json({ error:'Token requis.' });
    const token = header.split(' ')[1];
    let decoded;
    try { decoded = jwt.verify(token, process.env.JWT_SECRET); }
    catch(e) {
      if (e.name==='TokenExpiredError') return res.status(401).json({ error:'Token expiré.', code:'TOKEN_EXPIRED' });
      return res.status(401).json({ error:'Token invalide.' });
    }
    if (decoded.type !== 'access') return res.status(401).json({ error:'Type de token invalide.' });

    const db   = getDatabase();
    const user = await db.findOne('users', { id:decoded.sub });
    if (!user) return res.status(401).json({ error:'Utilisateur introuvable.' });
    if (user.is_banned) return res.status(403).json({ error:'Compte suspendu.' });

    req.user = user;
    next();
  } catch(e) {
    console.error('[auth-middleware]', e);
    res.status(500).json({ error:'Erreur authentification.' });
  }
}

function adminMiddleware(req, res, next) {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_SECRET_KEY)
    return res.status(403).json({ error:'Accès refusé.' });
  next();
}

// Middleware: vérifier accès quiz (free ou premium)
async function quizAccessMiddleware(req, res, next) {
  const user = req.user;
  const FREE_LIMIT = parseInt(process.env.FREE_QUIZ_LIMIT)||20;

  // Vérifier si premium actif
  const isPremium = user.plan !== 'free'
    && user.subscription_end
    && new Date(user.subscription_end) > new Date();

  if (isPremium) {
    req.isPremium = true;
    return next();
  }

  // Vérifier quota gratuit
  if ((user.quiz_free_used||0) < FREE_LIMIT) {
    req.isPremium = false;
    return next();
  }

  return res.status(402).json({
    error:'Quota gratuit épuisé.',
    code:'PREMIUM_REQUIRED',
    message: `Vous avez utilisé vos ${FREE_LIMIT} quiz gratuits. Passez en Premium pour continuer.`,
    plans: {
      premium_monthly: { price: parseInt(process.env.PREMIUM_MONTHLY_PRICE)||3000, label:'3 000 FCFA / mois', duration:'1 mois' },
      premium_yearly:  { price: parseInt(process.env.PREMIUM_YEARLY_PRICE)||15000, label:'15 000 FCFA / an', duration:'1 an', savings:'Économisez 21 000 FCFA vs mensuel' }
    }
  });
}

module.exports = { authMiddleware, adminMiddleware, quizAccessMiddleware };