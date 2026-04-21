// ============================================================
// src/config/database.js — COUCHE D'ABSTRACTION BASE DE DONNÉES
// ============================================================
// ✅ PATTERN ADAPTER: Le reste du code n'importe QUE ce fichier
// ✅ Pour changer de DB: modifier UNIQUEMENT ce fichier
// ✅ Supporte: PostgreSQL, MySQL, MongoDB, SQLite, Supabase, PlanetScale...
// ============================================================
//
// ── CHOISIR VOTRE BASE DE DONNÉES ──────────────────────────
//
//  Option A — PostgreSQL (recommandé production)
//    npm install pg
//    DB_TYPE=postgres dans .env
//
//  Option B — MySQL / MariaDB
//    npm install mysql2
//    DB_TYPE=mysql dans .env
//
//  Option C — MongoDB
//    npm install mongoose
//    DB_TYPE=mongodb dans .env
//
//  Option D — Supabase (PostgreSQL hébergé, gratuit)
//    npm install @supabase/supabase-js
//    DB_TYPE=supabase dans .env
//
//  Option E — SQLite (développement local, zéro config)
//    npm install better-sqlite3
//    DB_TYPE=sqlite dans .env
//
// ── CHOISIR VOTRE SERVEUR ──────────────────────────────────
//
//  Option 1 — VPS Ubuntu (Hetzner ~4€/mois, DigitalOcean ~6$/mois)
//  Option 2 — Railway.app (gratuit jusqu'à 500h/mois)
//  Option 3 — Render.com (gratuit avec limitations)
//  Option 4 — Fly.io (free tier disponible)
//  Option 5 — Vercel + Supabase (serverless, gratuit)
//
// ============================================================

require('dotenv').config();
const DB_TYPE = process.env.DB_TYPE || 'postgres'; // Changer ici

// ──────────────────────────────────────────────────────────
// INTERFACE COMMUNE — Toutes les méthodes que le code utilise
// ──────────────────────────────────────────────────────────
class DatabaseAdapter {
  async connect() { throw new Error('connect() non implémenté'); }
  async disconnect() {}
  async query(sql, params) { throw new Error('query() non implémenté'); }
  async findOne(table, where) { throw new Error('findOne() non implémenté'); }
  async findMany(table, where, opts) { throw new Error('findMany() non implémenté'); }
  async insert(table, data) { throw new Error('insert() non implémenté'); }
  async update(table, data, where) { throw new Error('update() non implémenté'); }
  async delete(table, where) { throw new Error('delete() non implémenté'); }
  async count(table, where) { throw new Error('count() non implémenté'); }
  async transaction(fn) { throw new Error('transaction() non implémenté'); }
  // Questions spéciales
  async getUnseenQuestions(userId, level, cycle, limit) { throw new Error('non implémenté'); }
}

// ══════════════════════════════════════════════════════════
// ADAPTATEUR POSTGRESQL (pg)
// ══════════════════════════════════════════════════════════
class PostgresAdapter extends DatabaseAdapter {
  constructor() {
    super();
    const { Pool } = require('pg');
    this.pool = new Pool({
      // ⚠️ REMPLACER par votre connexion PostgreSQL
      connectionString: process.env.DATABASE_URL,
      // OU décomposer:
      // host:     process.env.DB_HOST,
      // port:     parseInt(process.env.DB_PORT) || 5432,
      // database: process.env.DB_NAME,
      // user:     process.env.DB_USER,
      // password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 20,                    // Taille du pool de connexions
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
    this.pool.on('error', (err) => console.error('[DB] Erreur pool:', err.message));
  }

  async query(sql, params = []) {
    const client = await this.pool.connect();
    try {
      const result = await client.query(sql, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  async findOne(table, where = {}) {
    const keys = Object.keys(where);
    if (!keys.length) return null;
    const conds = keys.map((k, i) => `"${k}" = $${i+1}`).join(' AND ');
    const rows = await this.query(`SELECT * FROM "${table}" WHERE ${conds} LIMIT 1`, Object.values(where));
    return rows[0] || null;
  }

  async findMany(table, where = {}, opts = {}) {
    const keys = Object.keys(where);
    const vals = Object.values(where);
    let sql = `SELECT * FROM "${table}"`;
    if (keys.length) sql += ` WHERE ` + keys.map((k,i) => `"${k}" = $${i+1}`).join(' AND ');
    if (opts.orderBy) sql += ` ORDER BY "${opts.orderBy}" ${opts.order || 'ASC'}`;
    if (opts.limit)   sql += ` LIMIT ${parseInt(opts.limit)}`;
    if (opts.offset)  sql += ` OFFSET ${parseInt(opts.offset)}`;
    return await this.query(sql, vals);
  }

  async insert(table, data) {
    const keys = Object.keys(data);
    const vals = Object.values(data);
    const cols = keys.map(k => `"${k}"`).join(', ');
    const phs  = keys.map((_,i) => `$${i+1}`).join(', ');
    const rows = await this.query(
      `INSERT INTO "${table}" (${cols}) VALUES (${phs}) RETURNING *`, vals
    );
    return rows[0];
  }

  async update(table, data, where) {
    const dataKeys  = Object.keys(data);
    const dataVals  = Object.values(data);
    const whereKeys = Object.keys(where);
    const whereVals = Object.values(where);
    const sets  = dataKeys.map((k,i) => `"${k}" = $${i+1}`).join(', ');
    const conds = whereKeys.map((k,i) => `"${k}" = $${dataKeys.length+i+1}`).join(' AND ');
    const rows = await this.query(
      `UPDATE "${table}" SET ${sets} WHERE ${conds} RETURNING *`,
      [...dataVals, ...whereVals]
    );
    return rows[0];
  }

  async delete(table, where) {
    const keys = Object.keys(where);
    const conds = keys.map((k,i) => `"${k}" = $${i+1}`).join(' AND ');
    await this.query(`DELETE FROM "${table}" WHERE ${conds}`, Object.values(where));
  }

  async count(table, where = {}) {
    const keys = Object.keys(where);
    let sql = `SELECT COUNT(*) FROM "${table}"`;
    if (keys.length) sql += ` WHERE ` + keys.map((k,i) => `"${k}" = $${i+1}`).join(' AND ');
    const rows = await this.query(sql, Object.values(where));
    return parseInt(rows[0].count);
  }

  async transaction(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getUnseenQuestions(userId, level, cycle, limit) {
    return await this.query(`
      SELECT q.*, c.name AS category_name
      FROM questions q
      JOIN categories c ON c.id = q.category_id
      WHERE q.cycle = $1 AND q.level = $2 AND q.is_active = true
        AND q.id NOT IN (
          SELECT question_id FROM user_seen_questions WHERE user_id = $3
        )
      ORDER BY RANDOM()
      LIMIT $4
    `, [cycle, level, userId, limit]);
  }
}

// ══════════════════════════════════════════════════════════
// ADAPTATEUR MYSQL (mysql2)
// ══════════════════════════════════════════════════════════
class MySQLAdapter extends DatabaseAdapter {
  constructor() {
    super();
    const mysql = require('mysql2/promise');
    this.pool = mysql.createPool({
      // ⚠️ REMPLACER par votre connexion MySQL
      host:     process.env.DB_HOST     || 'localhost',
      port:     parseInt(process.env.DB_PORT) || 3306,
      database: process.env.DB_NAME,
      user:     process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl:      process.env.DB_SSL === 'true' ? {} : undefined,
      waitForConnections: true,
      connectionLimit: 20,
      queueLimit: 0,
    });
  }

  async query(sql, params = []) {
    // MySQL utilise ? au lieu de $1, $2...
    const [rows] = await this.pool.execute(sql, params);
    return rows;
  }

  async findOne(table, where = {}) {
    const keys = Object.keys(where);
    if (!keys.length) return null;
    const conds = keys.map(k => `\`${k}\` = ?`).join(' AND ');
    const rows = await this.query(`SELECT * FROM \`${table}\` WHERE ${conds} LIMIT 1`, Object.values(where));
    return rows[0] || null;
  }

  async findMany(table, where = {}, opts = {}) {
    const keys = Object.keys(where);
    let sql = `SELECT * FROM \`${table}\``;
    if (keys.length) sql += ` WHERE ` + keys.map(k => `\`${k}\` = ?`).join(' AND ');
    if (opts.orderBy) sql += ` ORDER BY \`${opts.orderBy}\` ${opts.order || 'ASC'}`;
    if (opts.limit)   sql += ` LIMIT ${parseInt(opts.limit)}`;
    if (opts.offset)  sql += ` OFFSET ${parseInt(opts.offset)}`;
    return await this.query(sql, Object.values(where));
  }

  async insert(table, data) {
    const keys = Object.keys(data);
    const cols = keys.map(k => `\`${k}\``).join(', ');
    const phs  = keys.map(() => '?').join(', ');
    const [result] = await this.pool.execute(
      `INSERT INTO \`${table}\` (${cols}) VALUES (${phs})`, Object.values(data)
    );
    return await this.findOne(table, { id: result.insertId });
  }

  async update(table, data, where) {
    const sets  = Object.keys(data).map(k => `\`${k}\` = ?`).join(', ');
    const conds = Object.keys(where).map(k => `\`${k}\` = ?`).join(' AND ');
    await this.pool.execute(
      `UPDATE \`${table}\` SET ${sets} WHERE ${conds}`,
      [...Object.values(data), ...Object.values(where)]
    );
    return await this.findOne(table, where);
  }

  async delete(table, where) {
    const conds = Object.keys(where).map(k => `\`${k}\` = ?`).join(' AND ');
    await this.pool.execute(`DELETE FROM \`${table}\` WHERE ${conds}`, Object.values(where));
  }

  async count(table, where = {}) {
    const keys = Object.keys(where);
    let sql = `SELECT COUNT(*) as cnt FROM \`${table}\``;
    if (keys.length) sql += ` WHERE ` + keys.map(k => `\`${k}\` = ?`).join(' AND ');
    const rows = await this.query(sql, Object.values(where));
    return parseInt(rows[0].cnt);
  }

  async transaction(fn) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      return result;
    } catch(e) {
      await conn.rollback(); throw e;
    } finally {
      conn.release();
    }
  }

  async getUnseenQuestions(userId, level, cycle, limit) {
    return await this.query(`
      SELECT q.*, c.name AS category_name
      FROM questions q
      JOIN categories c ON c.id = q.category_id
      WHERE q.cycle = ? AND q.level = ? AND q.is_active = 1
        AND q.id NOT IN (
          SELECT question_id FROM user_seen_questions WHERE user_id = ?
        )
      ORDER BY RAND()
      LIMIT ?
    `, [cycle, level, userId, limit]);
  }
}

// ══════════════════════════════════════════════════════════
// ADAPTATEUR SUPABASE (si vous choisissez Supabase)
// ══════════════════════════════════════════════════════════
class SupabaseAdapter extends DatabaseAdapter {
  constructor() {
    super();
    const { createClient } = require('@supabase/supabase-js');
    this.db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }

  async findOne(table, where = {}) {
    let q = this.db.from(table).select('*');
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    const { data, error } = await q.limit(1).single();
    if (error && error.code !== 'PGRST116') throw error;
    return data;
  }

  async findMany(table, where = {}, opts = {}) {
    let q = this.db.from(table).select('*');
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    if (opts.orderBy) q = q.order(opts.orderBy, { ascending: opts.order !== 'DESC' });
    if (opts.limit)   q = q.limit(opts.limit);
    if (opts.offset)  q = q.range(opts.offset, opts.offset + (opts.limit || 20) - 1);
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  async insert(table, data) {
    const { data: row, error } = await this.db.from(table).insert(data).select().single();
    if (error) throw error;
    return row;
  }

  async update(table, data, where) {
    let q = this.db.from(table).update(data);
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    const { data: row, error } = await q.select().single();
    if (error) throw error;
    return row;
  }

  async delete(table, where) {
    let q = this.db.from(table).delete();
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    const { error } = await q;
    if (error) throw error;
  }

  async count(table, where = {}) {
    let q = this.db.from(table).select('*', { count: 'exact', head: true });
    for (const [k, v] of Object.entries(where)) q = q.eq(k, v);
    const { count, error } = await q;
    if (error) throw error;
    return count || 0;
  }

  async transaction(fn) {
    // Supabase ne supporte pas les transactions côté client
    // Utiliser des Edge Functions ou RPC pour les transactions critiques
    return await fn(this.db);
  }

  async getUnseenQuestions(userId, level, cycle, limit) {
    const { data, error } = await this.db.rpc('get_unseen_questions_educ', {
      p_user_id: userId, p_level: level, p_cycle: cycle, p_limit: limit
    });
    if (error) throw error;
    return data || [];
  }
}

// ══════════════════════════════════════════════════════════
// ADAPTATEUR SQLITE (développement local)
// ══════════════════════════════════════════════════════════
class SQLiteAdapter extends DatabaseAdapter {
  constructor() {
    super();
    const Database = require('better-sqlite3');
    this.db = new Database(process.env.SQLITE_PATH || './bobdoeduc.db');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
  }

  async query(sql, params = []) {
    if (sql.trim().toUpperCase().startsWith('SELECT')) {
      return this.db.prepare(sql).all(params);
    }
    const info = this.db.prepare(sql).run(params);
    return [{ lastID: info.lastInsertRowid, changes: info.changes }];
  }

  async findOne(table, where = {}) {
    const keys = Object.keys(where);
    if (!keys.length) return null;
    const conds = keys.map(k => `"${k}" = ?`).join(' AND ');
    return this.db.prepare(`SELECT * FROM "${table}" WHERE ${conds} LIMIT 1`).get(Object.values(where)) || null;
  }

  async findMany(table, where = {}, opts = {}) {
    const keys = Object.keys(where);
    let sql = `SELECT * FROM "${table}"`;
    if (keys.length) sql += ` WHERE ` + keys.map(k => `"${k}" = ?`).join(' AND ');
    if (opts.orderBy) sql += ` ORDER BY "${opts.orderBy}" ${opts.order || 'ASC'}`;
    if (opts.limit)   sql += ` LIMIT ${parseInt(opts.limit)}`;
    if (opts.offset)  sql += ` OFFSET ${parseInt(opts.offset)}`;
    return this.db.prepare(sql).all(Object.values(where));
  }

  async insert(table, data) {
    const keys = Object.keys(data);
    const cols = keys.map(k => `"${k}"`).join(', ');
    const phs  = keys.map(() => '?').join(', ');
    const info = this.db.prepare(`INSERT INTO "${table}" (${cols}) VALUES (${phs})`).run(Object.values(data));
    return this.db.prepare(`SELECT * FROM "${table}" WHERE rowid = ?`).get(info.lastInsertRowid);
  }

  async update(table, data, where) {
    const sets  = Object.keys(data).map(k => `"${k}" = ?`).join(', ');
    const conds = Object.keys(where).map(k => `"${k}" = ?`).join(' AND ');
    this.db.prepare(`UPDATE "${table}" SET ${sets} WHERE ${conds}`)
      .run([...Object.values(data), ...Object.values(where)]);
    return this.findOne(table, where);
  }

  async delete(table, where) {
    const conds = Object.keys(where).map(k => `"${k}" = ?`).join(' AND ');
    this.db.prepare(`DELETE FROM "${table}" WHERE ${conds}`).run(Object.values(where));
  }

  async count(table, where = {}) {
    const keys = Object.keys(where);
    let sql = `SELECT COUNT(*) as cnt FROM "${table}"`;
    if (keys.length) sql += ` WHERE ` + keys.map(k => `"${k}" = ?`).join(' AND ');
    const row = this.db.prepare(sql).get(Object.values(where));
    return row?.cnt || 0;
  }

  async transaction(fn) {
    const trx = this.db.transaction(fn);
    return trx();
  }

  async getUnseenQuestions(userId, level, cycle, limit) {
    return this.db.prepare(`
      SELECT q.*, c.name AS category_name
      FROM questions q
      JOIN categories c ON c.id = q.category_id
      WHERE q.cycle = ? AND q.level = ? AND q.is_active = 1
        AND q.id NOT IN (
          SELECT question_id FROM user_seen_questions WHERE user_id = ?
        )
      ORDER BY RANDOM()
      LIMIT ?
    `).all([cycle, level, userId, limit]);
  }
}

// ══════════════════════════════════════════════════════════
// FACTORY — Instanciation selon DB_TYPE
// ══════════════════════════════════════════════════════════
let _db = null;

function getDatabase() {
  if (_db) return _db;
  switch (DB_TYPE) {
    case 'postgres':  _db = new PostgresAdapter();  break;
    case 'mysql':     _db = new MySQLAdapter();     break;
    case 'supabase':  _db = new SupabaseAdapter();  break;
    case 'sqlite':    _db = new SQLiteAdapter();    break;
    default:
      throw new Error(`DB_TYPE non supporté: "${DB_TYPE}". Valeurs: postgres, mysql, supabase, sqlite`);
  }
  console.log(`✅ Base de données connectée: [${DB_TYPE.toUpperCase()}]`);
  return _db;
}

module.exports = { getDatabase };
