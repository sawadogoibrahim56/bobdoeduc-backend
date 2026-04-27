// ============================================================
// server.js â€” BobdoEduc VERSION B
// ============================================================
'use strict';
require('dotenv').config();
const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const morgan    = require('morgan');
const rateLimit = require('express-rate-limit');
const path      = require('path');

// â”€â”€ Imports routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const authRouter  = require('./src/auth/auth.routes');
const quizRouter  = require('./src/quiz/quiz.routes');          // fichier sÃ©parÃ© âœ…
const subRouter   = require('./src/subscription/subscription.routes');
const adminRouter = require('./src/admin/admin.routes');
const usersRouter = require('./src/users/users.routes');
const qsRouter    = require('./src/questions/questions.routes');

const app = express();

// â”€â”€ SÃ©curitÃ© â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(helmet({ contentSecurityPolicy: false, hsts: { maxAge: 31536000 } }));
app.use(cors({
  origin:       process.env.FRONTEND_URL || '*',
  methods:      ['GET','POST','PUT','PATCH','DELETE'],
  allowedHeaders:['Content-Type','Authorization','X-Admin-Key'],
  credentials:  true
}));
app.use(express.json({ limit: '10kb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// â”€â”€ Rate limiting â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use('/api/',                     rateLimit({ windowMs:15*60*1000, max:100, standardHeaders:true, legacyHeaders:false }));
app.use('/api/auth/login',           rateLimit({ windowMs:60*60*1000, max:10  }));
app.use('/api/auth/register',        rateLimit({ windowMs:60*60*1000, max:10  }));
app.use('/api/auth/send-otp',        rateLimit({ windowMs:60*1000,    max:3   }));
app.use('/api/subscription/request', rateLimit({ windowMs:60*60*1000, max:3   }));

// â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use('/api/auth',         authRouter);
app.use('/api/quiz',         quizRouter);
app.use('/api/subscription', subRouter);
app.use('/api/admin',        adminRouter);
app.use('/api/users',        usersRouter);
app.use('/api/questions',    qsRouter);

// Panel admin servi statiquement
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/admin.html'));
});

// Health check
app.get('/health', (req, res) => res.json({
  status:  'ok',
  version: 'B',
  db:      process.env.DB_TYPE  || 'non configurÃ©',
  env:     process.env.NODE_ENV || 'development'
}));

// 404
app.use((req, res) => res.status(404).json({ error: 'Route non trouvÃ©e' }));

// Erreur globale
app.use((err, req, res, next) => {
  console.error('[ERR]', err.message);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Erreur interne du serveur' : err.message
  });
});

// â”€â”€ DÃ©marrage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`\nâœ…  BobdoEduc API VERSION B â€” port ${PORT}`);
  console.log(`    DB          : ${process.env.DB_TYPE             || 'âš ï¸  non configurÃ©'}`);
  console.log(`    Env         : ${process.env.NODE_ENV            || 'development'}`);
  console.log(`    Admin email : ${process.env.ADMIN_EMAIL         || 'âš ï¸  non configurÃ©'}`);
  console.log(`    Email mode  : ${process.env.EMAIL_PROVIDER      || 'console (dev)'}`);
  console.log(`    Free limit  : ${process.env.FREE_QUIZ_LIMIT     || 20} quiz\n`);
});
    
