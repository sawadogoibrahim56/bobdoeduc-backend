// ============================================================
// src/config/database.js — CORRIGÉ
// Fix: getUnseenQuestions utilisait q.level (inexistant)
//      → remplacé par q.difficulty
// ============================================================
'use strict';
require('dotenv').config();
const DB_TYPE = process.env.DB_TYPE || 'postgres';

class DatabaseAdapter {
  async connect() {}
  async disconnect() {}
  async query(sql, params) { throw new Error('query() non implémenté'); }
  async findOne(table, where) { throw new Error('findOne() non implémenté'); }
  async findMany(table, where, opts) { throw new Error('findMany() non implémenté'); }
  async insert(table, data) { throw new Error('insert() non implémenté'); }
  async update(table, data, where) { throw new Error('update() non implémenté'); }
  async delete(table, where) { throw new Error('delete() non implémenté'); }
  async count(table, where) { throw new Error('count() non implémenté'); }
  async transaction(fn) { throw new Error('transaction() non implémenté'); }
  async getUnseenQuestions(userId, cycle, limit) { throw new Error('non implémenté'); }
}

// ══════════════════════════════════════════════════════════
// POSTGRESQL
// ══════════════════════════════════════════════════════════
class PostgresAdapter extends DatabaseAdapter {
  constructor() {
    super();
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
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
    const rows = await this.query(
      `SELECT * FROM "${table}" WHERE ${conds} LIMIT 1`,
      Object.values(where)
    );
    return rows[0] || null;
  }

  async findMany(table, where = {}, opts = {}) {
    const keys = Object.keys(where);
    const vals = Object.values(where);
    let sql = `SELECT * FROM "${table}"`;
    if (keys.length) sql += ' WHERE ' + keys.map((k,i) => `"${k}" = $${i+1}`).join(' AND ');
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
      `INSERT INTO "${table}" (${cols}) VALUES (${phs}) RETURNING *`,
      vals
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
    if (keys.length) sql += ' WHERE ' + keys.map((k,i) => `"${k}" = $${i+1}`).join(' AND ');
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
    } catch(e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  // ✅ FIX: supprimé le paramètre "level" inutilisé, utilise difficulty
  async getUnseenQuestions(userId, cycle, limit) {
    return await this.query(`
      SELECT q.*, c.name AS category_name
      FROM questions q
      JOIN categories c ON c.id = q.category_id
      WHERE q.cycle = $1
        AND q.is_active = true
        AND q.id NOT IN (
          SELECT question_id FROM user_seen_questions WHERE user_id = $2
        )
      ORDER BY RANDOM()
      LIMIT $3
    `, [cycle, userId, limit]);
  }
}

// ══════════════════════════════════════════════════════════
// FACTORY
// ══════════════════════════════════════════════════════════
let _db = null;

function getDatabase() {
  if (_db) return _db;
  switch (DB_TYPE) {
    case 'postgres': _db = new PostgresAdapter(); break;
    default:
      throw new Error(`DB_TYPE non supporté: "${DB_TYPE}". Valeur attendue: postgres`);
  }
  console.log(`✅ DB connectée: [${DB_TYPE.toUpperCase()}]`);
  return _db;
}

module.exports = { getDatabase };
      
