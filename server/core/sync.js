'use strict';
/**
 * M3 多端接入与消息同步（FR-404）
 *
 * 设计（统一会话服务，端仅负责渲染）：
 *   - 设备注册：每端一个 device_token（dt_ 前缀，长期有效），绑定 user_id
 *   - 增量同步：以 messages.rowid 作为全局单调游标 seq，端上保存 last_seq，
 *     每次拉取 rowid > last_seq 的属于本人的消息 → 多端顺序一致、无重复
 *   - 离线补收：任意时刻带着旧游标重连，即完整补收错过的消息
 *   - 会话归属：消息按 sessions.student_id 归属本人，端无法越权拉取
 */
const db = require('../db');
const { uid, now } = require('./util');

const DEVICE_TYPES = ['web', 'h5', 'miniprogram', 'vscode'];

/** 注册设备：返回长期 device_token */
function registerDevice(userId, { deviceType, name } = {}) {
  if (!DEVICE_TYPES.includes(deviceType)) {
    throw Object.assign(new Error('设备类型仅支持：' + DEVICE_TYPES.join(' / ')), { status: 400 });
  }
  const id = uid('dv');
  const token = 'dt_' + require('node:crypto').randomBytes(16).toString('hex');
  db.insert('devices', {
    id, user_id: userId, device_type: deviceType, name: name || deviceType,
    device_token: token, last_seq: 0, last_seen_at: now(), created_at: now(),
  });
  return { deviceId: id, deviceToken: token, deviceType };
}

/** 通过设备令牌解析用户（供小程序/插件等无会话 Cookie 的端使用） */
function userOfDeviceToken(token) {
  if (!token || !token.startsWith('dt_')) return null;
  const d = db.get('SELECT * FROM devices WHERE device_token=?', [token]);
  if (!d) return null;
  db.update('devices', 'id', d.id, { last_seen_at: now() });
  const u = db.get('SELECT * FROM users WHERE user_id=?', [d.user_id]);
  return u ? { user: u, device: d } : null;
}

/** 我的全局消息游标（最大 rowid） */
function maxSeq() {
  const r = db.get('SELECT MAX(rowid) AS m FROM messages');
  return r && r.m ? r.m : 0;
}

/**
 * 增量拉取本人消息（多端共用，保证顺序一致、无重复、离线可补收）
 * @param {string} userId
 * @param {number} since 端上保存的游标（首次传 0 全量）
 */
function syncMessages(userId, since = 0) {
  const student = db.get(
    'SELECT student_id FROM students WHERE student_id=(SELECT ref_id FROM users WHERE user_id=?)',
    [userId]
  );
  const studentId = student ? student.student_id : null;
  // 教师/助教等非学生账号：可同步预警提醒类广播（这里返回空消息体 + 游标，端上渲染工作台）
  const rows = studentId
    ? db.all(
        `SELECT m.rowid AS seq, m.msg_id, m.session_id, m.role, m.content, m.level, m.engine, m.created_at
         FROM messages m JOIN sessions s ON s.session_id = m.session_id
         WHERE s.student_id=? AND m.rowid > ? ORDER BY m.rowid ASC LIMIT 500`,
        [studentId, since]
      )
    : [];
  const cursor = rows.length ? rows[rows.length - 1].seq : maxSeq();
  return {
    messages: rows,
    cursor: Math.max(Number(since) || 0, cursor),
    hasMore: rows.length >= 500,
  };
}

/** 记录端上的游标（服务端可观测各端同步进度） */
function ackCursor(deviceId, seq) {
  const r = db.update('devices', 'id', deviceId, { last_seq: Number(seq) || 0, last_seen_at: now() });
  return { deviceId, seq: Number(seq) || 0, updated: r.changes > 0 };
}

/** 端侧清单：设备列表（本人） */
function myDevices(userId) {
  return db.all(
    'SELECT id, device_type, name, last_seq, last_seen_at, created_at FROM devices WHERE user_id=? ORDER BY created_at DESC',
    [userId]
  ).map((d) => ({ deviceId: d.id, deviceType: d.device_type, name: d.name, lastSeq: d.last_seq, lastSeenAt: d.last_seen_at }));
}

/** 撤销设备令牌 */
function revokeDevice(userId, deviceId) {
  const r = db.run('DELETE FROM devices WHERE id=? AND user_id=?', [deviceId, userId]);
  return { removed: r.changes > 0 };
}

module.exports = { DEVICE_TYPES, registerDevice, userOfDeviceToken, syncMessages, ackCursor, myDevices, revokeDevice, maxSeq };
