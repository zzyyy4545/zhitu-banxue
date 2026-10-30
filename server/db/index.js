'use strict';
/**
 * 数据访问层：基于 Node 内置 node:sqlite（零第三方依赖）
 * - 参数归一化：boolean -> 0/1，undefined -> null，object/array -> JSON 字符串
 * - 提供 run / get / all / tx，统一行转驼峰不必要，直接返回原列名
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.ZHITU_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const DB_FILE = process.env.ZHITU_DB || path.join(DATA_DIR, 'zhitu.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = null;

function norm(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

function open() {
  if (db) return db;
  db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

function run(sql, params = []) {
  const d = open();
  const stmt = d.prepare(sql);
  const info = stmt.run(...(Array.isArray(params) ? params.map(norm) : [norm(params)]));
  return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
}

function get(sql, params = []) {
  const d = open();
  const stmt = d.prepare(sql);
  const row = stmt.get(...(Array.isArray(params) ? params.map(norm) : [norm(params)]));
  return row || null;
}

function all(sql, params = []) {
  const d = open();
  const stmt = d.prepare(sql);
  return stmt.all(...(Array.isArray(params) ? params.map(norm) : [norm(params)]));
}

function exec(sql) {
  return open().exec(sql);
}

function tx(fn) {
  const d = open();
  d.exec('BEGIN');
  try {
    const r = fn();
    d.exec('COMMIT');
    return r;
  } catch (e) {
    try {
      d.exec('ROLLBACK');
    } catch (_) {
      /* ignore */
    }
    throw e;
  }
}

/** 轻量迁移：为已存在的库补加后加的列（避免强制重建，保护教学数据） */
const MIGRATIONS = [
  { table: 'sessions', column: 'draft', def: "TEXT DEFAULT '{}'" },
  // M4（FR-701）：账号生命周期（active / disabled）
  { table: 'users', column: 'status', def: "TEXT DEFAULT 'active'" },
  // M4（FR-402）：触达消息保留发送时原文（教师改文案不改写历史）
  { table: 'outreach_logs', column: 'text_sent', def: 'TEXT' },
];

function migrate() {
  for (const m of MIGRATIONS) {
    try {
      const cols = all(`PRAGMA table_info(${m.table})`);
      if (!cols.some((c) => c.name === m.column)) {
        exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.def}`);
      }
    } catch (_) {
      /* 表不存在时忽略 */
    }
  }
}

function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  exec(sql);
  migrate();
}

/** 从 camelCase 对象生成 INSERT（只插入给定字段） */
function insert(table, obj) {
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
  if (!keys.length) throw new Error('insert: empty object');
  const cols = keys.join(', ');
  const ph = keys.map(() => '?').join(', ');
  return run(
    `INSERT INTO ${table} (${cols}) VALUES (${ph})`,
    keys.map((k) => obj[k])
  );
}

/** 生成 UPDATE ... WHERE key = ? */
function update(table, key, keyVal, patch) {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined && k !== key);
  if (!keys.length) return { changes: 0 };
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  return run(
    `UPDATE ${table} SET ${sets} WHERE ${key} = ?`,
    [...keys.map((k) => patch[k]), keyVal]
  );
}

function count(table, where = '1=1', params = []) {
  const row = get(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`, params);
  return row ? row.c : 0;
}

module.exports = {
  open,
  run,
  get,
  all,
  exec,
  tx,
  insert,
  update,
  count,
  initSchema,
  DB_FILE,
  DATA_DIR,
};
