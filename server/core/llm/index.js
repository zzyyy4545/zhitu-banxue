'use strict';
/**
 * 模型适配层（FR-702 模型与成本治理）
 *
 * 设计要点：
 *   - 未配置 API → 使用内置规则引擎（离线可用，行为确定，便于教学侧评审）
 *   - 已配置 API → OpenAI 兼容 /chat/completions；分级路由（light / strong）
 *   - 答案缓存：同类问题命中率目标 ≥30%
 *   - 失败降级：超时 / 非 2xx / 解析失败 → 回落规则引擎，绝不静默失败（2.3 约束 4）
 *   - 每次调用记录 model_ver，供留痕与成本日报表
 */
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../db');
const { uid, now, jparse } = require('../util');

const CONFIG_FILE = process.env.ZHITU_LLM_CONFIG || path.join(__dirname, '..', '..', '..', 'data', 'llm.json');

const DEFAULT_CONFIG = {
  enabled: false,
  provider: 'openai-compatible',
  baseUrl: '',
  apiKey: '',
  strongModel: '',
  lightModel: '',
  timeoutMs: 15000,
  cacheEnabled: true,
  maxTokens: 800, // 限制输出长度：控制成本，也避免推理型模型生成过长导致超时降级
};

/**
 * 环境变量覆盖（优先级高于 data/llm.json）：
 * 便于在部署脚本 / 容器中注入密钥，而不把 Key 落盘。
 *   ZHITU_LLM_ENABLED=1  ZHITU_LLM_BASE_URL=...  ZHITU_LLM_API_KEY=sk-...
 *   ZHITU_LLM_MODEL=...  ZHITU_LLM_LIGHT_MODEL=...  ZHITU_LLM_TIMEOUT_MS=...
 */
function envOverride() {
  const e = process.env;
  const o = {};
  if (e.ZHITU_LLM_ENABLED !== undefined) o.enabled = /^(1|true|yes|on)$/i.test(e.ZHITU_LLM_ENABLED);
  if (e.ZHITU_LLM_BASE_URL) o.baseUrl = e.ZHITU_LLM_BASE_URL;
  if (e.ZHITU_LLM_API_KEY) o.apiKey = e.ZHITU_LLM_API_KEY;
  if (e.ZHITU_LLM_MODEL) o.strongModel = e.ZHITU_LLM_MODEL;
  if (e.ZHITU_LLM_LIGHT_MODEL) o.lightModel = e.ZHITU_LLM_LIGHT_MODEL;
  if (e.ZHITU_LLM_TIMEOUT_MS) o.timeoutMs = Number(e.ZHITU_LLM_TIMEOUT_MS) || DEFAULT_CONFIG.timeoutMs;
  return o;
}

function loadConfig() {
  let base = { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      base = { ...base, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
    }
  } catch (_) {
    /* ignore */
  }
  return { ...base, ...envOverride() };
}

/**
 * 规范接口前缀：OpenAI 兼容网关的对话接口位于 /v1 下。
 * 允许配置成「https://gw.example.com」或「https://gw.example.com/v1」两种写法。
 */
function apiBase(baseUrl, apiKey) {
  const b = String(baseUrl || '').replace(/\/+$/, '');
  if (!b) return '';
  return /\/v\d+$/.test(b) ? b : b + '/v1';
}

function saveConfig(cfg) {
  const dir = path.dirname(CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ ...DEFAULT_CONFIG, ...cfg }, null, 2), 'utf8');
  return loadConfig();
}

let config = loadConfig();
function getConfig() {
  return { ...config, apiKey: config.apiKey ? '***已配置***' : '' };
}
function reload() {
  config = loadConfig();
  return getConfig();
}

// ---- 缓存（进程内，简单 LRU 思路：上限后清空一半）----
const CACHE = new Map();
const CACHE_MAX = 500;
let cacheHit = 0;
let cacheMiss = 0;

function cacheKeyOf(payload) {
  return JSON.stringify({ m: payload.model, t: payload.text, l: payload.level, s: payload.stage });
}

function cacheGet(key) {
  if (!config.cacheEnabled) return null;
  const v = CACHE.get(key);
  if (v) {
    cacheHit++;
    return v;
  }
  cacheMiss++;
  return null;
}
function cacheSet(key, val) {
  if (!config.cacheEnabled) return;
  if (CACHE.size >= CACHE_MAX) {
    const del = Math.floor(CACHE_MAX / 2);
    let i = 0;
    for (const k of CACHE.keys()) {
      if (i++ >= del) break;
      CACHE.delete(k);
    }
  }
  CACHE.set(key, val);
}

function cacheStats() {
  const total = cacheHit + cacheMiss;
  return { hit: cacheHit, miss: cacheMiss, rate: total ? +(cacheHit / total).toFixed(3) : 0, size: CACHE.size };
}

/** 调用 OpenAI 兼容接口 */
async function callChat({ model, systemPrompt, userPrompt, temperature = 0.7, baseUrl, apiKey }) {
  const url = apiBase(baseUrl || config.baseUrl, apiKey || config.apiKey) + '/chat/completions';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs || 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + (apiKey || config.apiKey),
      },
      body: JSON.stringify({
        model,
        temperature,
        max_tokens: config.maxTokens || 800,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('MODEL_HTTP_' + res.status);
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    return { content, usage: data?.usage || null, model };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 列出网关可用模型（GET /v1/models）
 * 用于解决「模型 ID 到底填什么」的问题——网关的模型清单是动态的。
 */
async function listModels(override = {}) {
  const base = apiBase(override.baseUrl || config.baseUrl, override.apiKey || config.apiKey);
  const key = override.apiKey || config.apiKey;
  if (!base || !key) throw Object.assign(new Error('未配置接口地址或 API Key'), { status: 400 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs || 15000);
  try {
    const res = await fetch(base + '/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + key },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error('MODEL_HTTP_' + res.status + ' ' + body.slice(0, 120));
    }
    const d = await res.json();
    const ids = (d && d.data ? d.data : []).map((m) => m.id).filter(Boolean);
    return { base, count: ids.length, models: ids };
  } finally {
    clearTimeout(timer);
  }
}

/** 连通性测试：拉取模型清单 + 用强模型跑一次最小对话 */
async function testConnection(override = {}) {
  const t0 = Date.now();
  const out = { ok: false, base: '', modelCount: 0, models: [], model: '', latencyMs: 0, sample: '', error: '' };
  try {
    const lm = await listModels(override);
    out.base = lm.base;
    out.modelCount = lm.count;
    out.models = lm.models;
    const model = override.strongModel || config.strongModel || lm.models[0];
    if (!model) throw new Error('网关未返回可用模型，请确认该 Key 的模型权限');
    out.model = model;
    const r = await callChat({
      model,
      systemPrompt: '你是中文助手，回答务必简短。',
      userPrompt: '只回复两个字：可用',
      temperature: 0.1,
      baseUrl: override.baseUrl,
      apiKey: override.apiKey,
    });
    out.sample = String(r.content || '').slice(0, 60);
    out.latencyMs = Date.now() - t0;
    out.ok = true;
  } catch (e) {
    out.error = String(e.message || e);
    out.latencyMs = Date.now() - t0;
  }
  return out;
}

/** 从模型输出中抽取 JSON（容错：允许 ```json 围栏） */
function extractJson(text) {
  const t = String(text || '').trim();
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : t;
  try {
    return JSON.parse(body);
  } catch (_) {
    const s = body.indexOf('{');
    const e = body.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try {
        return JSON.parse(body.slice(s, e + 1));
      } catch (__) {
        return null;
      }
    }
    return null;
  }
}

/** 记录模型调用（成本治理日报表用） */
function logCall(row) {
  try {
    db.insert('model_calls', {
      id: uid('mc'),
      session_id: row.sessionId || null,
      student_id: row.studentId || null,
      model: row.model || '',
      engine: row.engine || 'rule',
      tier: row.tier || 'strong',
      cached: row.cached ? 1 : 0,
      prompt_tokens: row.promptTokens || 0,
      completion_tokens: row.completionTokens || 0,
      latency_ms: row.latencyMs || 0,
      fallback: row.fallback ? 1 : 0,
      created_at: now(),
    });
  } catch (_) {
    /* 表不存在时忽略（seed 会建） */
  }
}

/**
 * 生成导学回复
 * @param {object} p
 *   systemPrompt  string
 *   userPrompt    string
 *   level, stage, tier('light'|'strong'), sessionId, studentId
 *   ruleFallback  () => object   规则引擎兜底（必需）
 * @returns {{data:object, engine:'llm'|'rule', model:string, fallback:boolean, latencyMs:number, cached:boolean}}
 */
async function generate(p) {
  const started = Date.now();
  const usable = config.enabled && config.apiKey && config.baseUrl;

  if (!usable) {
    const data = p.ruleFallback();
    logCall({ ...p, engine: 'rule', model: 'rule-engine', latencyMs: Date.now() - started });
    return { data, engine: 'rule', model: 'rule-engine-v1', fallback: false, latencyMs: Date.now() - started, cached: false };
  }

  // M3 成本治理（FR-702）：每日配额超限 → 直接走规则引擎降级，导学不断线
  if (p.studentId && !require('../cost').checkQuota(p.studentId)) {
    const data = p.ruleFallback();
    logCall({ ...p, engine: 'rule', model: 'rule-engine', fallback: true, latencyMs: Date.now() - started });
    return {
      data, engine: 'rule', model: 'rule-engine-v1', fallback: true,
      latencyMs: Date.now() - started, cached: false, error: 'QUOTA_EXCEEDED',
    };
  }

  const model = p.tier === 'light' ? config.lightModel || config.strongModel : config.strongModel;
  const key = cacheKeyOf({ model, text: p.userPrompt, level: p.level, stage: p.stage });
  const cached = cacheGet(key);
  if (cached) {
    logCall({ ...p, engine: 'llm', model, cached: true, latencyMs: Date.now() - started });
    return { data: cached, engine: 'llm', model, fallback: false, latencyMs: Date.now() - started, cached: true };
  }

  try {
    const r = await callChat({
      model,
      systemPrompt: p.systemPrompt,
      userPrompt: p.userPrompt,
      temperature: p.tier === 'light' ? 0.3 : 0.7,
    });
    const parsed = extractJson(r.content);
    if (!parsed || typeof parsed.reply_text !== 'string') {
      throw new Error('MODEL_BAD_JSON');
    }
    cacheSet(key, parsed);
    logCall({
      ...p, engine: 'llm', model,
      promptTokens: r.usage?.prompt_tokens || 0,
      completionTokens: r.usage?.completion_tokens || 0,
      latencyMs: Date.now() - started,
    });
    return { data: parsed, engine: 'llm', model, fallback: false, latencyMs: Date.now() - started, cached: false };
  } catch (e) {
    // 降级：规则引擎兜底，绝不静默失败
    const data = p.ruleFallback();
    logCall({ ...p, engine: 'rule', model: 'rule-engine', fallback: true, latencyMs: Date.now() - started });
    return {
      data, engine: 'rule', model: 'rule-engine-v1', fallback: true,
      latencyMs: Date.now() - started, cached: false, error: e.message,
    };
  }
}

module.exports = {
  generate, getConfig, saveConfig, reload, cacheStats,
  extractJson, CONFIG_FILE, listModels, testConnection, apiBase,
  isEnabled: () => !!(config.enabled && config.apiKey && config.baseUrl),
  rawConfig: () => config,
};
