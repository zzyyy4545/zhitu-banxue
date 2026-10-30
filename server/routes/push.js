'use strict';
/**
 * M3 运营接口：推送渠道管理（FR-503/507）+ 成本治理看板（FR-702）
 *
 *   GET    /api/v1/teacher/push/channels         渠道列表
 *   POST   /api/v1/teacher/push/channels         新增渠道（wecom_webhook / inbox）
 *   PUT    /api/v1/teacher/push/channels/:id     更新（改名 / 换 webhook / 启停）
 *   DELETE /api/v1/teacher/push/channels/:id     删除
 *   POST   /api/v1/teacher/push/channels/:id/test 发送测试消息（触达验证）
 *   POST   /api/v1/teacher/push/notify           把某条预警推送至所有启用渠道
 *   GET    /api/v1/teacher/push/logs             推送日志与触达统计
 *   GET    /api/v1/teacher/cost/usage?days=7     模型用量 / 缓存命中 / 降级统计
 */
const auth = require('../middleware/auth');
const push = require('../core/push');
const cost = require('../core/cost');
const db = require('../db');

module.exports = function (app) {
  app.get('/api/v1/teacher/push/channels', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    res.json({ channels: push.list() });
  });

  app.post('/api/v1/teacher/push/channels', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const c = push.addChannel(req.body || {});
    auth.audit(req.user.user_id, req.user.role, 'push_channel_add', c.id, { type: c.type, name: c.name });
    res.json({ channel: c });
  });

  app.put('/api/v1/teacher/push/channels/:id', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const c = push.updateChannel(req.params.id, req.body || {});
    auth.audit(req.user.user_id, req.user.role, 'push_channel_update', req.params.id, req.body || {});
    res.json({ channel: c });
  });

  app.delete('/api/v1/teacher/push/channels/:id', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const r = push.removeChannel(req.params.id);
    auth.audit(req.user.user_id, req.user.role, 'push_channel_delete', req.params.id, {});
    res.json(r);
  });

  app.post('/api/v1/teacher/push/channels/:id/test', auth.requireRole('teacher', 'ta', 'admin'), async (req, res) => {
    const r = await push.send({
      channelId: req.params.id,
      title: '知途伴学 · 渠道连通性测试',
      body: `由 ${req.user.name || req.user.username} 于 ${new Date().toLocaleString('zh-CN')} 触发。收到本消息说明渠道可用。`,
      target: 'test',
    });
    res.json(r);
  });

  app.post('/api/v1/teacher/push/notify', auth.requireRole('teacher', 'ta', 'admin'), async (req, res) => {
    const { alertId } = req.body || {};
    const alert = db.get('SELECT * FROM alerts WHERE alert_id=?', [alertId]);
    if (!alert) throw Object.assign(new Error('预警不存在'), { status: 404 });
    const results = await push.notifyAlert(alert);
    res.json({ results, delivered: results.filter((r) => r.ok).length });
  });

  app.get('/api/v1/teacher/push/logs', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    res.json(push.logs({ channelId: req.query.channelId, limit: Number(req.query.limit) || 50 }));
  });

  app.get('/api/v1/teacher/cost/usage', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    res.json(cost.usage({ days: Number(req.query.days) || 7 }));
  });
};
