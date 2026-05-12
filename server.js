// ============================================================
// server.js — BobdoEduc VERSION B Audité
// ============================================================
'use strict';
require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');

const authRouter  = require('./src/auth/auth.routes');
const quizRouter  = require('./src/quiz/quiz.routes');
const subRouter   = require('./src/subscription/subscription.routes');
const adminRouter = require('./src/admin/admin.routes');
const usersRouter = require('./src/users/users.routes');
const qsRouter    = require('./src/questions/questions.routes');

const app = express();

// Trust proxy (Render)
app.set('trust proxy', 1);

// CORS
const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.FRONTEND_URL_2,
  'http://localhost:3000',
  'http://localhost:4000',
  'http://127.0.0.1:5500',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    if (process.env.NODE_ENV !== 'production') return cb(null, true);
    console.warn('[CORS bloqué]', origin);
    cb(new Error('CORS bloqué: ' + origin));
  },
  methods:      ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders:['Content-Type','Authorization','X-Admin-Key'],
  credentials:  true
}));

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10kb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Rate limiting
const rl = (max, win) => rateLimit({
  windowMs: win * 60 * 1000, max,
  standardHeaders: true, legacyHeaders: false,
  skip: () => process.env.NODE_ENV !== 'production'
});

app.use('/api/',               rl(300, 15));
app.use('/api/auth/login',     rl(15, 60));
app.use('/api/auth/register',  rl(10, 60));
app.use('/api/auth/send-otp',  rl(10, 1));

// Routes
app.use('/api/auth',         authRouter);
app.use('/api/quiz',         quizRouter);
app.use('/api/subscription', subRouter);
app.use('/api/admin',        adminRouter);
app.use('/api/users',        usersRouter);
app.use('/api/questions',    qsRouter);

// Health
app.get('/health', (req, res) => res.json({
  status:  'ok',
  version: 'B',
  db:      process.env.DB_TYPE      || '⚠️ non configuré',
  env:     process.env.NODE_ENV     || 'development',
  email:   process.env.EMAIL_PROVIDER || 'console',
  cors:    allowedOrigins
}));

// 404
app.use((req, res) => res.status(404).json({ error: 'Route non trouvée: ' + req.path }));

// Erreur globale
app.use((err, req, res, next) => {
  console.error('[ERR]', err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Erreur interne' : err.message
  });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n✅  BobdoEduc API — port ${PORT}`);
  console.log(`    DB      : ${process.env.DB_TYPE          || '⚠️  non configuré'}`);
  console.log(`    Env     : ${process.env.NODE_ENV         || 'development'}`);
  console.log(`    Email   : ${process.env.EMAIL_PROVIDER   || 'console (dev)'}`);
  console.log(`    CORS    : ${allowedOrigins.join(', ')}\n`);
});
