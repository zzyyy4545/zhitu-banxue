'use strict';
/**
 * 阶段策略注册表（说明书 3.2 开发提示：六阶段共用一套「阶段策略配置」，
 * 差异体现在提示词、红线规则与产出物 Schema 上，新增阶段不应修改核心代码）
 *
 * 新增阶段：写一个符合本目录约定的配置文件，在此处 require 并 push 即可。
 */
const requirements = require('./requirements');
const architecture = require('./architecture');
const coding = require('./coding');
const testing = require('./testing');
const review = require('./review');
const retro = require('./retro');

const REGISTRY = [requirements, architecture, coding, testing, review, retro]
  .slice()
  .sort((a, b) => a.order - b.order);

const BY_KEY = new Map(REGISTRY.map((s) => [s.key, s]));

function all() {
  return REGISTRY;
}

function get(key) {
  return BY_KEY.get(key) || null;
}

function nodeOf(stageKey, nodeId) {
  const s = get(stageKey);
  if (!s) return null;
  return s.nodes.find((n) => n.id === nodeId) || s.nodes[0] || null;
}

function nextNode(stageKey, nodeId) {
  const s = get(stageKey);
  if (!s) return null;
  const i = s.nodes.findIndex((n) => n.id === nodeId);
  if (i < 0 || i + 1 >= s.nodes.length) return null;
  return s.nodes[i + 1];
}

function progressOf(stageKey, nodeId) {
  const s = get(stageKey);
  if (!s) return 0;
  const i = s.nodes.findIndex((n) => n.id === nodeId);
  if (i < 0) return 0;
  return Math.round(((i + 1) / s.nodes.length) * 100);
}

/** 注册一个新阶段（供扩展用） */
function register(stageConfig) {
  if (BY_KEY.has(stageConfig.key)) BY_KEY.delete(stageConfig.key);
  BY_KEY.set(stageConfig.key, stageConfig);
  const i = REGISTRY.findIndex((s) => s.key === stageConfig.key);
  if (i >= 0) REGISTRY.splice(i, 1);
  REGISTRY.push(stageConfig);
  REGISTRY.sort((a, b) => (a.order || 99) - (b.order || 99));
  return stageConfig;
}

// ---------------- 通用校验器（配置驱动，非硬编码） ----------------

/** 粗略统计条数：换行 / 数字编号 / 分号分隔 */
function countItems(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  const byNumbered = (t.match(/(?:^|[\n；;])\s*\d+[、.．)]\s*\S+/g) || []).length;
  const byLine = t.split(/[\n；;。]/).filter((x) => x.trim().length > 2).length;
  return Math.max(byNumbered, byLine);
}

/**
 * 校验学生输入是否满足当前节点要求
 * @returns {{ok:boolean, issues:string[], branch:string|null, extracted:object}}
 */
function validate(node, text) {
  const t = String(text || '').trim();
  const issues = [];
  let branch = null;
  const extracted = {};

  // 抽取字段到产出物
  if (Array.isArray(node.extract)) {
    for (const rule of node.extract) {
      try {
        const m = t.match(new RegExp(rule.re));
        if (m && m[1]) extracted[rule.field] = m[1].trim();
      } catch (_) {
        /* 忽略非法正则 */
      }
    }
  }

  const c = node.check || {};

  if (c.minLength && t.length < c.minLength) {
    issues.push(`说得还不够具体，至少把这一步讲清楚（${t.length}/${c.minLength} 字）`);
  }

  if (Array.isArray(c.required)) {
    for (const r of c.required) {
      try {
        if (!new RegExp(r.re).test(t)) issues.push(r.msg);
      } catch (_) {
        /* ignore */
      }
    }
  }

  if (Array.isArray(c.signals)) {
    for (const s of c.signals) {
      try {
        if (new RegExp(s.re).test(t)) {
          if (s.branch) branch = s.branch;
          if (s.level !== 'hint') issues.push(s.msg);
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  if (c.minItems && countItems(t) < c.minItems) {
    issues.push(`条数不足，至少需要 ${c.minItems} 条（当前 ${countItems(t)} 条）`);
  }

  return { ok: issues.length === 0, issues, branch, extracted };
}

module.exports = {
  all, get, nodeOf, nextNode, progressOf, register, validate, countItems,
  keys: () => REGISTRY.map((s) => s.key),
};
