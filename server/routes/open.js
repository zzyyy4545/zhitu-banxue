'use strict';
/**
 * M3 多端开放接口（FR-404：小程序 / 企业微信 / LMS / VS Code 插件 / Web 五端共用）
 *
 * 认证：两 种方式任选其一
 *   1. 用户令牌：Authorization: Bearer tk_...（Web 端登录令牌）
 *   2. 设备令牌：Authorization: Bearer dt_...（小程序 / VS Code 插件长期令牌，POST /open/devices 换取）
 *
 * 接口：
 *   POST /api/v1/open/devices                注册设备 → deviceToken
 *   GET  /api/v1/open/me                     端侧启动信息（用户 / 会话列表）
 *   GET  /api/v1/open/sync?since=0           增量消息同步（离线补收；多端顺序一致）
 *   POST /api/v1/open/sync/ack               上报游标
 *   GET  /api/v1/open/devices                我的设备列表
 *   DELETE /api/v1/open/devices/:id          撤销设备
 *   POST /api/v1/open/sessions/:id/messages  发消息（channel 记录来源端；
 *                                              支持 codeContext：VS Code 选中代码求助）
 */
const db = require('../db');
const auth = require('../middleware/auth');
const sync = require('../core/sync');
const pipeline = require('../core/pipeline');
const stages = require('../core/stages');

/** 端侧鉴权：用户令牌 或 设备令牌 */
function attachDeviceUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query && req.query.token) || null;
  if (!token) return null;
  if (token.startsWith('dt_')) {
    const r = sync.userOfDeviceToken(token);
    return r ? r.user : null;
  }
  return auth.parseAuth(req);
}

function requireOpenAuth(req) {
  const user = attachDeviceUser(req);
  if (!user) {
    const e = new Error('未登录或设备令牌无效');
    e.status = 401;
    throw e;
  }
  req.user = user;
  return user;
}

module.exports = function (app) {
  app.post('/api/v1/open/devices', (req, res) => {
    const user = (function () {
      try { return requireOpenAuth(req); } catch (_) { return null; }
    })();
    if (!user) {
      const e = new Error('注册设备需先登录（Bearer 用户令牌）');
      e.status = 401;
      throw e;
    }
    const { deviceType, name } = req.body || {};
    const r = sync.registerDevice(user.user_id, { deviceType, name });
    auth.audit(user.user_id, user.role, 'device_register', r.deviceId, { deviceType });
    res.json(r);
  });

  app.get('/api/v1/open/me', (req, res) => {
    const user = requireOpenAuth(req);
    const student = auth.studentOf(user);
    const sessions = student
      ? db.all('SELECT session_id, stage, title, level, last_at FROM sessions WHERE student_id=? ORDER BY last_at DESC LIMIT 10', [student.student_id])
      : [];
    res.json({
      user: { userId: user.user_id, name: user.name, role: user.role },
      student: student ? { studentId: student.student_id, name: student.name, groupId: student.group_id } : null,
      sessions,
    });
  });

  /** 增量同步：since 为端上保存的游标（首次 0 全量；断线重连同一路径补收） */
  app.get('/api/v1/open/sync', (req, res) => {
    const user = requireOpenAuth(req);
    const r = sync.syncMessages(user.user_id, Number(req.query.since || 0) || 0);
    const student = auth.studentOf(user);
    const unread = student
      ? db.count('outreach_logs', 'student_id=?', [student.student_id])
      : 0;
    res.json({ ...r, unreadOutreach: unread, serverTime: new Date().toISOString() });
  });

  app.post('/api/v1/open/sync/ack', (req, res) => {
    const user = requireOpenAuth(req);
    const { deviceId, seq } = req.body || {};
    if (!deviceId) throw Object.assign(new Error('缺少 deviceId'), { status: 400 });
    res.json(sync.ackCursor(deviceId, seq));
  });

  app.get('/api/v1/open/devices', (req, res) => {
    const user = requireOpenAuth(req);
    res.json({ devices: sync.myDevices(user.user_id) });
  });

  app.delete('/api/v1/open/devices/:id', (req, res) => {
    const user = requireOpenAuth(req);
    res.json(sync.revokeDevice(user.user_id, req.params.id));
  });

  /**
   * 端侧发消息：与 Web 端共用同一条 pipeline（统一会话服务，端仅负责渲染）
   * VS Code 插件可附 codeContext（文件路径 + 选中行 + 代码片段），自动拼入求助上下文
   */
  app.post('/api/v1/open/sessions/:id/messages', async (req, res) => {
    const user = requireOpenAuth(req);
    const s = db.get('SELECT * FROM sessions WHERE session_id=?', [req.params.id]);
    if (!s) throw Object.assign(new Error('会话不存在'), { status: 404 });
    auth.assertStudentVisible(user, s.student_id);
    const student = db.get('SELECT * FROM students WHERE student_id=?', [s.student_id]);
    const { text, codeContext } = req.body || {};

    let ctxNote = '';
    if (codeContext && (codeContext.file || codeContext.selection)) {
      ctxNote = `\n（来自 VS Code：文件 ${codeContext.file || '未命名'}${
        codeContext.line ? ' 第 ' + codeContext.line + ' 行附近' : ''
      }，选中内容如下）\n${String(codeContext.selection || '').slice(0, 800)}`;
    }

    const out = await pipeline.handleMessage({
      student,
      sessionId: s.session_id,
      text: (text || '') + ctxNote,
      attachments: [],
      channel: s.channel || 'web',
    });
    res.json({
      reply: out.reply,
      context: out.context,
      session: { sessionId: out.session.session_id, stage: out.session.stage, nodeId: out.session.node_id, level: out.session.level },
    });
  });

  void stages;
};
