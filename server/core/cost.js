'use strict';
/**
 * M3 成本治理（FR-702 补全：分级路由已有 + 缓存已有，本模块补每日配额与用量看板）
 *
 * - 用量统计：聚合 model_calls（调用数 / 缓存命中 / token / 降级次数 / 平均耗时）
 * - 每日配额：每生每日模型调用上限，超限自动走规则引擎（导学不断线，成本不失控）
 *   上限可用环境变量 ZHITU_MODEL_DAILY_CAP 覆盖，默认 60
 */
const db = require('../db');
const { dayKey } = require('./util');

function dailyCap() {
  return Number(process.env.ZHITU_MODEL_DAILY_CAP || 60) || 60;
}

/** 某学生今日已消耗的模型调用次数 */
function usedToday(studentId) {
  return db.count(
    'model_calls',
    "student_id=? AND created_at LIKE ? AND engine='llm'",
    [studentId, dayKey() + '%']
  );
}

/** 配额检查：未超返回 true */
function checkQuota(studentId) {
  if (!studentId) return true;
  return usedToday(studentId) < dailyCap();
}

/**
 * 用量看板数据（教师端）
 * @param {object} p {days=7}
 */
function usage({ days = 7 } = {}) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const byDay = db.all(
    `SELECT substr(created_at,1,10) AS d, engine, COUNT(*) AS calls,
            SUM(cached) AS cached, SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct,
            SUM(fallback) AS fallback, AVG(latency_ms) AS avg_ms
     FROM model_calls WHERE created_at>=? GROUP BY d, engine ORDER BY d`,
    [since]
  );
  const byModel = db.all(
    `SELECT model, tier, COUNT(*) AS calls, SUM(cached) AS cached,
            SUM(prompt_tokens + completion_tokens) AS tokens, AVG(latency_ms) AS avg_ms
     FROM model_calls WHERE created_at>=? AND engine='llm' GROUP BY model, tier ORDER BY calls DESC`,
    [since]
  );
  const totalRow = db.get(
    `SELECT COUNT(*) AS calls, SUM(CASE WHEN engine='llm' THEN 1 ELSE 0 END) AS llm,
            SUM(cached) AS cached, SUM(fallback) AS fallback,
            SUM(prompt_tokens + completion_tokens) AS tokens
     FROM model_calls WHERE created_at>=?`,
    [since]
  );
  const llm = require('./llm');
  return {
    days,
    total: {
      calls: totalRow.calls || 0,
      llm: totalRow.llm || 0,
      rule: (totalRow.calls || 0) - (totalRow.llm || 0),
      cached: totalRow.cached || 0,
      fallback: totalRow.fallback || 0,
      tokens: totalRow.tokens || 0,
    },
    cache: llm.cacheStats(),
    quota: { dailyCap: dailyCap(), policy: '超限自动降级规则引擎，导学不断线' },
    byDay: byDay.map((r) => ({
      date: r.d, engine: r.engine, calls: r.calls, cached: r.cached || 0,
      tokens: (r.pt || 0) + (r.ct || 0), fallback: r.fallback || 0, avgMs: Math.round(r.avg_ms || 0),
    })),
    byModel: byModel.map((r) => ({
      model: r.model, tier: r.tier, calls: r.calls, cached: r.cached || 0,
      tokens: r.tokens || 0, avgMs: Math.round(r.avg_ms || 0),
    })),
  };
}

module.exports = { dailyCap, usedToday, checkQuota, usage };
