// ============================================================
// server.js — BobdoEduc VERSION B
// ============================================================
require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');

const authRouter  = require('./src/auth/auth.routes');
const { quizRouter } = require('./src/guards/auth.middleware');
const subRouter   = require('./src/subscription/subscription.routes');
const adminRouter = require('./src/admin/admin.routes');
const usersRouter = require('./src/users/users.routes');
const qsRouter    = require('./src/questions/questions.routes');

const app = express();

app.use(helmet({ contentSecurityPolicy:false, hsts:{ maxAge:31536000 } }));
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  methods: ['GET','POST','PUT','PATCH','DELETE'],
  allowedHeaders: ['Content-Type','Authorization','X-Admin-Key'],
  credentials: true
}));
app.use(express.json({ limit:'10kb' }));
app.use(morgan(process.env.NODE_ENV==='production' ? 'combined' : 'dev'));

// RATE LIMITING
app.use('/api/',              rateLimit({ windowMs:15*60*1000, max:100, message:{error:'Trop de requêtes.'} }));
app.use('/api/auth/login',    rateLimit({ windowMs:60*60*1000, max:10,  message:{error:'Trop de tentatives.'} }));
app.use('/api/auth/register', rateLimit({ windowMs:60*60*1000, max:10,  message:{error:'Trop de tentatives.'} }));
app.use('/api/auth/send-otp', rateLimit({ windowMs:60*1000,    max:3,   message:{error:'Trop d\'envois OTP.'} }));
// Rate limit sur les demandes d'abonnement (max 3 par heure par IP)
app.use('/api/subscription/request', rateLimit({ windowMs:60*60*1000, max:3, message:{error:'Trop de demandes.'} }));

// ROUTES
app.use('/api/auth',         authRouter);
app.use('/api/quiz',         quizRouter);
app.use('/api/subscription', subRouter);
app.use('/api/admin',        adminRouter);   // ← NOUVEAU en version B
app.use('/api/users',        usersRouter);
app.use('/api/questions',    qsRouter);

// Servir le panel admin statiquement (optionnel)
const path = require('path');
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../../frontend/admin.html'));
});

app.get('/health', (req, res) => res.json({
  status:'ok', version:'B', db:process.env.DB_TYPE, env:process.env.NODE_ENV
}));

app.use((req, res) => res.status(404).json({ error:'Route non trouvée' }));
app.use((err, req, res, next) => {
  console.error('[ERR]', err.message);
  res.status(err.status||500).json({ error: process.env.NODE_ENV==='production'?'Erreur interne':err.message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n✅  BobdoEduc API VERSION B — port ${PORT}`);
  console.log(`    DB          : ${process.env.DB_TYPE || 'non configuré'}`);
  console.log(`    Env         : ${process.env.NODE_ENV || 'development'}`);
  console.log(`    Admin email : ${process.env.ADMIN_EMAIL || '⚠️  non configuré'}`);
  console.log(`    Email mode  : ${process.env.EMAIL_PROVIDER || 'console (dev)'}`);
  console.log(`    Panel admin : http://localhost:${PORT}/admin\n`);
});
