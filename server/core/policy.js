'use strict';
/**
 * FR-505 介入封顶层配置
 *
 * 约束：
 *   - 层级只能取 L1–L4，不允许「无限制」（边界条款）
 *   - 支持全局默认 + 班级/小组/任务覆盖 + 阶段维度
 *   - 支持定时生效（active_from / active_to），如「Sprint 最后 3 天放开到 L3」
 *   - 所有变更写入审计日志
 *   - 学生端可见当前封顶层（透明原则）
 */
const db = require('../db');
const { uid, now, clampLevel } = require('./util');

const SCOPE_RANK = { task: 4, group: 3, class: 2, global: 1 };

/** 默认封顶策略（对齐说明书 10.3 建议取值） */
const DEFAULT_CAPS = {
  requirements: 2, // 需求澄清 L2
  architecture: 2, // 架构设计 L2
  coding: 1,       // 编码结对 L1
  testing: 2,      // 测试验证 L2
  review: 2,       // 评审答辩 L2
  retro: 2,        // 复盘沉淀 L2
};

function assertCap(v) {
  // 先按原始值校验区间，再 clamp：
  // 若先 clamp，9 会被静默修正为 4，等于允许配置「无限制」（违反边界条款）
  const raw = Number(v);
  if (!Number.isFinite(raw) || raw < 1 || raw > 4) {
    const e = new Error('封顶层只能取 L1–L4，不允许配置为「无限制」');
    e.status = 400;
    throw e;
  }
  return clampLevel(raw);
}

/**
 * 解析生效的封顶层
 * @param {{classId,groupId,stage,taskId,at}} q
 * @returns {{cap, source, policyId, from, to}}
 */
function resolveCap(q = {}) {
  const at = q.at || now();
  const stage = q.stage || null;
  const rows = db.all(
    `SELECT * FROM policies
     WHERE (active_from IS NULL OR active_from <= ?)
       AND (active_to IS NULL OR active_to >= ?)`,
    [at, at]
  );

  let best = null;
  for (const p of rows) {
    // scope 匹配
    let scopeHit = false;
    if (p.scope === 'global') scopeHit = true;
    else if (p.scope === 'class' && q.classId && p.scope_id === q.classId) scopeHit = true;
    else if (p.scope === 'group' && q.groupId && p.scope_id === q.groupId) scopeHit = true;
    else if (p.scope === 'task' && q.taskId && p.scope_id === q.taskId) scopeHit = true;
    if (!scopeHit) continue;

    // 阶段匹配：空 = 不限阶段（可作为兜底）
    const stageHit = !p.stage || p.stage === stage;
    if (!stageHit) continue;

    const rank = SCOPE_RANK[p.scope] || 0;
    const stageBonus = p.stage === stage ? 0.5 : 0; // 同 rank 下精确匹配阶段优先
    const score = rank + stageBonus;
    if (!best || score > best.score) best = { score, p };
  }

  if (best) {
    return {
      cap: clampLevel(best.p.cap_level),
      source: best.p.scope + (best.p.stage ? '/' + best.p.stage : ''),
      policyId: best.p.policy_id,
      from: best.p.active_from,
      to: best.p.active_to,
    };
  }
  // 无策略记录 → 阶段默认值
  return { cap: DEFAULT_CAPS[stage] || 2, source: 'default/' + (stage || 'all'), policyId: null };
}

/** 写入/更新一条策略（同 scope+scope_id+stage+时间窗 视为同一条，覆盖更新） */
function setPolicy({ scope, scopeId, stage, capLevel, activeFrom, activeTo, updatedBy, note }) {
  assertCap(capLevel);
  const existing = db.get(
    `SELECT * FROM policies WHERE scope=? AND IFNULL(scope_id,'')=IFNULL(?,'') AND IFNULL(stage,'')=IFNULL(?, '')`,
    [scope, scopeId || null, stage || null]
  );
  const ts = now();
  if (existing) {
    db.run(
      `UPDATE policies SET cap_level=?, active_from=?, active_to=?, updated_by=?, updated_at=?, note=? WHERE policy_id=?`,
      [capLevel, activeFrom || null, activeTo || null, updatedBy || null, ts, note || null, existing.policy_id]
    );
    return { policyId: existing.policy_id, action: 'updated' };
  }
  const id = uid('pol');
  db.insert('policies', {
    policy_id: id,
    scope,
    scope_id: scopeId || null,
    stage: stage || null,
    cap_level: capLevel,
    active_from: activeFrom || null,
    active_to: activeTo || null,
    updated_by: updatedBy || null,
    updated_at: ts,
    note: note || null,
  });
  return { policyId: id, action: 'created' };
}

function listPolicies(scope) {
  const w = scope ? 'WHERE scope=?' : '';
  return db.all(`SELECT * FROM policies ${w} ORDER BY updated_at DESC`, scope ? [scope] : []);
}

function deletePolicy(id) {
  return db.run('DELETE FROM policies WHERE policy_id=?', [id]);
}

module.exports = { resolveCap, setPolicy, listPolicies, deletePolicy, DEFAULT_CAPS, assertCap };
