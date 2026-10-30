'use strict';
/**
 * M3 推送通道（FR-503 预警推送 / 6.2 外部对接：消息推送）
 *
 * - 渠道管理：企业微信群机器人 webhook（markdown 消息）/ 站内（降级方案）
 * - 所有推送写 push_logs 留痕（触达统计与推送记录一致，FR-507 验收）
 * - 发送失败不抛异常：记录 error，教师端可见（降级路径验证，9.4 故障演练）
 */
const db = require('../db');
const { uid, now, jparse } = require('./util');

/** 创建渠道 */
function addChannel({ name, type = 'wecom_webhook', webhook, scope } = {}) {
  if (!name) throw Object.assign(new Error('渠道必须有名称'), { status: 400 });
  if (type === 'wecom_webhook' && !/^https?:\/\//.test(String(webhook || ''))) {
    throw Object.assign(new Error('企业微信渠道必须配置以 http(s):// 开头的机器人 Webhook 地址'), { status: 400 });
  }
  const id = uid('ch');
  db.insert('push_channels', {
    id, name, type, webhook: webhook || null,
    scope: JSON.stringify(scope || []), enabled: 1, created_at: now(), updated_at: now(),
  });
  return get(id);
}

function get(id) {
  return db.get('SELECT * FROM push_channels WHERE id=?', [id]);
}

function list() {
  return db.all('SELECT * FROM push_channels ORDER BY created_at').map(masked);
}

/** webhook 含密钥参数，列表返回时打码 */
function masked(c) {
  return { ...c, webhook: c.webhook ? c.webhook.replace(/([?&]key=)\w+/, '$1***') : null, scope: jparse(c.scope, []) };
}

function updateChannel(id, patch = {}) {
  const c = get(id);
  if (!c) throw Object.assign(new Error('渠道不存在'), { status: 404 });
  const p = {};
  if (patch.name !== undefined) p.name = patch.name;
  if (patch.webhook !== undefined) p.webhook = patch.webhook;
  if (patch.enabled !== undefined) p.enabled = patch.enabled ? 1 : 0;
  p.updated_at = now();
  db.update('push_channels', 'id', id, p);
  return masked(get(id));
}

function removeChannel(id) {
  const r = db.run('DELETE FROM push_channels WHERE id=?', [id]);
  return { removed: r.changes > 0 };
}

/**
 * 发送一条推送（同步返回结果，失败不抛异常）
 * @param {object} p {channelId, title, body, target}
 */
async function send({ channelId, title, body, target = 'teachers' }) {
  const c = get(channelId);
  if (!c) return { ok: false, error: 'channel_not_found' };
  if (!c.enabled) return { ok: false, error: 'channel_disabled' };
  let ok = false;
  let error = null;
  if (c.type === 'wecom_webhook') {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      try {
        const res = await fetch(c.webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msgtype: 'markdown',
            markdown: { content: `**${title}**\n${body}` },
          }),
          signal: ctrl.signal,
        });
        if (!res.ok) error = 'HTTP_' + res.status;
        else ok = true;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      error = String(e.message || e).slice(0, 120);
    }
  } else {
    // 站内渠道：始终成功（降级方案，7×24 可用）
    ok = true;
  }
  db.insert('push_logs', {
    id: uid('pl'), channel_id: c.id, target, title, body,
    ok: ok ? 1 : 0, error, created_at: now(),
  });
  return { ok, error, channelId: c.id, channelName: c.name, channelType: c.type };
}

/**
 * 预警推送给教师/助教（FR-503：推送渠道 站内 + 企业微信）
 * 对所有启用的渠道各发一份；任何一个失败不影响其他渠道。
 */
async function notifyAlert(alert) {
  const channels = db.all('SELECT * FROM push_channels WHERE enabled=1');
  const results = [];
  for (const c of channels) {
    results.push(await send({
      channelId: c.id,
      title: `知途预警 · ${alert.rule_id}`,
      body: `${alert.trigger_reason}\n建议：${alert.suggest || '-'}`,
      target: 'teachers',
    }));
  }
  return results;
}

/** 批量推送（教师群发 FR-507 的渠道侧），受众已由路由层筛好 */
async function broadcast({ title, body, targets = [] }) {
  const channels = db.all('SELECT * FROM push_channels WHERE enabled=1');
  const results = [];
  for (const c of channels) {
    results.push(await send({ channelId: c.id, title, body, target: targets.join(',') || 'all' }));
  }
  return results;
}

/** 推送日志（触达统计） */
function logs({ channelId, limit = 50 } = {}) {
  const rows = db.all(
    'SELECT * FROM push_logs' + (channelId ? ' WHERE channel_id=?' : '') + ' ORDER BY created_at DESC LIMIT ?',
    channelId ? [channelId, limit] : [limit]
  );
  const total = db.count('push_logs');
  const okCount = db.count('push_logs', 'ok=1');
  return { logs: rows, stats: { total, ok: okCount, fail: total - okCount } };
}

module.exports = { addChannel, get, list, updateChannel, removeChannel, send, notifyAlert, broadcast, logs };
