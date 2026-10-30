'use strict';
/**
 * FR-107 导学有效性自检（护栏 Agent）
 *
 * 放行前检查三项：
 *   1. 是否含完整可提交成果（完整故事卡 / 完整函数实现 / 完整文档正文 / 完整测试文件）
 *   2. 是否越层（输出深度 > 当前层级）
 *   3. 是否泄露其他小组数据
 *
 * 不通过 → 打回重写，最多 2 次；仍不通过 → 降级为固定话术 + 建议转人工。
 * 输出：pass / reject / downgrade + 原因码（写入 guardrail_logs 供审计与教师端「越界尝试」统计）
 */
const db = require('../db');
const { uid, now, jparse, maxCodeBlockLines } = require('./util');
const redline = require('./redline');

const DOWNGRADE_TEXT =
  '这一步我没法直接帮你——再往下说就是替你做了。\n我们把它拆开：你现在卡的是「不知道从哪下手」，还是「知道要做什么但写不出来」？\n如果拆完还是过不去，建议直接找老师或助教练一遍，这比在这儿绕快。';

/**
 * 估算输出深度（0–4），用于越层检测
 * 启发式：编号步骤 / 代码块 / 完整故事 / 成篇结构
 */
function estimateDepth(text) {
  const t = String(text || '');
  let depth = 0;

  // 步骤拆解特征
  const steps = (t.match(/^\s*(?:\d+[、.．)]|[①-⑨]|[-*])\s*\S+/gm) || []).length;
  if (steps >= 2) depth = Math.max(depth, 2);

  // 示例特征（代码块、引号示例、Given/When/Then）
  const code = maxCodeBlockLines(t);
  if (code > 0) depth = Math.max(depth, 3);
  if (/Given\s+.{0,80}When\s+.{0,80}Then\s+/i.test(t)) depth = Math.max(depth, 3);
  if (/(比如|例如|举个例子|参考一下)/.test(t) && t.length > 120) depth = Math.max(depth, 3);

  // 完整讲解特征：长篇幅 + 多个段落层次 + 结论性表述
  if (t.length > 500 && /(总结|本质|核心|原理|原因是|关键在于)/.test(t)) depth = Math.max(depth, 4);
  if (code > 15) depth = 4;

  return Math.min(4, depth);
}

/** 泄露检测：文本中是否出现非本组的项目名或成员姓名 */
function leakCheck(text, { groupId = null }) {
  if (!groupId) return { leak: false };
  const t = String(text || '');
  const others = db.all('SELECT group_id, project_name FROM groups WHERE group_id <> ?', [groupId]);
  for (const g of others) {
    if (g.project_name && g.project_name.length >= 3 && t.includes(g.project_name)) {
      return { leak: true, evidence: `提及他组项目：${g.project_name}` };
    }
  }
  // 他组成员姓名
  const names = db.all(
    `SELECT s.name FROM students s WHERE s.group_id IS NOT NULL AND s.group_id <> ?`,
    [groupId]
  );
  for (const n of names) {
    if (n.name && n.name.length >= 2 && t.includes(n.name)) {
      return { leak: true, evidence: `提及他组成员：${n.name}` };
    }
  }
  return { leak: false };
}

function logGuard(row) {
  db.insert('guardrail_logs', {
    log_id: uid('gl'),
    session_id: row.sessionId || null,
    student_id: row.studentId || null,
    stage: row.stage || null,
    level: row.level === undefined ? null : row.level,
    result: row.result,
    reason_code: row.reasonCode || null,
    detail: JSON.stringify(row.detail || {}),
    engine: row.engine || 'rule',
    created_at: now(),
  });
}

/**
 * 护栏校验主流程
 * @param {object} opts
 *   draft        string   导学 Agent 草稿
 *   level        number   当前允许层级
 *   capLevel     number   封顶层
 *   stage        string
 *   groupId      string
 *   sessionId, studentId
 *   engine       string   rule / llm
 *   regenerate   async (attempt, reason) => string  打回重写回调（LLM 引擎必需）
 */
async function inspect(opts) {
  const {
    draft, level, capLevel = 4, stage = null, groupId = null,
    sessionId = null, studentId = null, engine = 'rule', regenerate = null,
  } = opts;

  const maxLevel = Math.min(Number(level), Number(capLevel));
  const base = { sessionId, studentId, stage, level: maxLevel, engine };

  let attempt = 0;
  let text = String(draft || '');
  let lastReason = null;

  while (attempt <= 2) {
    // ① 越层检测
    const depth = estimateDepth(text);
    if (depth > maxLevel) {
      lastReason = { code: 'GR_OVER_LEVEL', detail: { depth, allowed: maxLevel, attempt } };
      logGuard({ ...base, result: 'reject', reasonCode: lastReason.code, detail: lastReason.detail });
    } else {
      // ② 完整成果检测（复用 FR-108 规则库，L4 放行）
      const rl = redline.check(text, { level: maxLevel, stage });
      if (rl.blocked) {
        lastReason = { code: rl.reason_code, detail: { rule: rl.rule, evidence: rl.evidence, attempt } };
        logGuard({ ...base, result: 'reject', reasonCode: rl.reason_code, detail: lastReason.detail });
      } else {
        // ③ 泄露检测
        const lk = leakCheck(text, { groupId });
        if (lk.leak) {
          lastReason = { code: 'GR_LEAK', detail: { evidence: lk.evidence, attempt } };
          logGuard({ ...base, result: 'reject', reasonCode: 'GR_LEAK', detail: lastReason.detail });
        } else {
          logGuard({ ...base, result: 'pass', reasonCode: null, detail: { attempt, depth } });
          return { result: 'pass', text, depth, attempts: attempt };
        }
      }
    }

    attempt++;
    if (attempt > 2) break;
    if (typeof regenerate === 'function') {
      try {
        text = await regenerate(attempt, lastReason);
      } catch (e) {
        break; // 重写失败 → 降级
      }
    } else {
      break; // 规则引擎无可重写 → 直接降级
    }
  }

  // 三次不过 → 降级（保守拦截）
  logGuard({
    ...base,
    result: 'downgrade',
    reasonCode: lastReason ? lastReason.code : 'GR_UNKNOWN',
    detail: { ...(lastReason ? lastReason.detail : {}), attempts: attempt },
  });
  return {
    result: 'downgrade',
    text: DOWNGRADE_TEXT,
    depth: estimateDepth(DOWNGRADE_TEXT),
    attempts: attempt,
    reason: lastReason,
    needHuman: true,
  };
}

module.exports = { inspect, estimateDepth, leakCheck, DOWNGRADE_TEXT };
