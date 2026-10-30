'use strict';
/**
 * 鉴权与角色权限（2.1 用户角色权限边界）
 * 学生：仅本人与本组数据；组长：本组全部数据；助教：所辖班级；教师：所辖班级全量；管理员：系统级
 */
const db = require('../db');
const { uid, now } = require('../core/util');

const TOKEN_TTL_HOURS = 12;
const TOKENS = new Map(); // token -> {userId}

function issueToken(user) {
  const token = uid('tk');
  TOKENS.set(token, { userId: user.user_id, at: Date.now() });
  return token;
}

function parseAuth(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query && req.query.token) || null;
  if (!token) return null;
  const rec = TOKENS.get(token);
  if (!rec) return null;
  if (Date.now() - rec.at > TOKEN_TTL_HOURS * 3600 * 1000) {
    TOKENS.delete(token);
    return null;
  }
  return db.get('SELECT * FROM users WHERE user_id=?', [rec.userId]);
}

/** 中间件：解析用户（不强制） */
function attachUser(req, res) {
  req.user = parseAuth(req);
}

/** 强制登录 */
function requireAuth(req, res) {
  attachUser(req, res);
  if (!req.user) {
    const e = new Error('未登录或登录已过期');
    e.status = 401;
    throw e;
  }
}

function requireRole(...roles) {
  return (req, res) => {
    requireAuth(req, res);
    if (!roles.includes(req.user.role)) {
      const e = new Error('无权访问：需要 ' + roles.join('/') + ' 角色');
      e.status = 403;
      throw e;
    }
  };
}

/** 学生数据归属校验：仅本人或本组组长可见 */
function assertStudentVisible(user, studentId) {
  if (user.role === 'admin') return true;
  if (user.role === 'teacher') return true; // 教师管辖范围在教学接口另行过滤
  if (user.role === 'ta') return true;
  if (user.role === 'student' && user.ref_id === studentId) return true;
  if (user.role === 'leader') {
    const me = db.get('SELECT group_id FROM students WHERE student_id=?', [user.ref_id]);
    const target = db.get('SELECT group_id FROM students WHERE student_id=?', [studentId]);
    return !!(me && target && me.group_id === target.group_id);
  }
  const e = new Error('无权访问该学生数据');
  e.status = 403;
  throw e;
}

/** 教师可见班级范围 */
function classScopeOf(user) {
  if (user.role === 'admin') return null; // 不限
  try {
    const s = JSON.parse(user.scope || '[]');
    return Array.isArray(s) && s.length ? s : null;
  } catch (_) {
    return null;
  }
}

/** 审计日志（FR-703） */
function audit(actorId, actorRole, action, target, detail = {}) {
  db.insert('audit_logs', {
    log_id: uid('au'),
    actor_id: actorId || null,
    actor_role: actorRole || null,
    action,
    target: target || null,
    detail: JSON.stringify(detail),
    created_at: now(),
  });
}

/** 学生身份（从登录账号映射到 students 表） */
function studentOf(user) {
  if (!user.ref_id) return null;
  return db.get('SELECT * FROM students WHERE student_id=?', [user.ref_id]);
}

module.exports = {
  issueToken, parseAuth, attachUser, requireAuth, requireRole,
  assertStudentVisible, classScopeOf, audit, studentOf, TOKENS,
};
