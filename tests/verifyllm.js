'use strict';
/**
 * 大模型生效性验证（需服务已启动，默认 http://127.0.0.1:3000）
 * 用法：node tests/verifyllm.js  →  npm run verify:llm
 *
 * 回答一个问题：**这条回复到底是不是大模型生成的？**
 * 三级验证：
 *   ① 网关直连 —— 地址/Key/模型权限通不通（不经过业务层）
 *   ② 端到端 —— 真实发一条求助，看路由返回的 source 字段
 *   ③ 留痕核对 —— 查 model_calls 表，确认 token 有真实消耗
 * 结论以最后一行 VERDICT 为准。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const BASE = process.env.ZHITU_BASE_URL || 'http://127.0.0.1:3000';
const OUT = path.join(__dirname, '_verifyllm.txt');

const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

async function req(method, url, { body, token } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    const res = await fetch(BASE + url, {
      method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const txt = await res.text();
    let json = null;
    try { json = JSON.parse(txt); } catch (_) { /* 非 JSON */ }
    return { status: res.status, json, text: txt };
  } finally {
    clearTimeout(timer);
  }
}

(async () => {
  log('===== 大模型生效性验证 =====');
  log('时间：' + new Date().toLocaleString('zh-CN'));
  log('服务：' + BASE);

  let verdict = { gateway: null, e2e: null, calls: null, final: '' };

  // ---------- ① 网关直连（不依赖服务运行）----------
  log('');
  log('【① 网关直连】');
  const cfgPath = path.join(ROOT, 'data', 'llm.json');
  let raw = {};
  try { raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch (_) { /* ignore */ }
  const apiKey = process.env.ZHITU_LLM_API_KEY || raw.apiKey || '';
  const baseUrl = process.env.ZHITU_LLM_BASE_URL || raw.baseUrl || '';
  const enabled = process.env.ZHITU_LLM_ENABLED !== undefined
    ? /^(1|true|yes|on)$/i.test(process.env.ZHITU_LLM_ENABLED)
    : !!raw.enabled;

  log('配置文件：' + cfgPath + (fs.existsSync(cfgPath) ? '（存在）' : '（不存在）'));
  log('启用开关：' + (enabled ? '开' : '关 ★ 关闭的话走的必然是规则引擎'));
  log('接口地址：' + (baseUrl || '（未配置）'));
  log('API Key ：' + (apiKey ? '已配置（' + apiKey.slice(0, 6) + '***' + apiKey.slice(-4) + '）' : '未配置 ★'));
  log('强模型 ：' + (raw.strongModel || '（未配置）'));
  log('轻量模型：' + (raw.lightModel || '（未配置）'));
  log('超时阈值：' + (raw.timeoutMs || 15000) + 'ms · 输出上限 ' + (raw.maxTokens || 800) + ' tokens');

  if (!baseUrl || !apiKey) {
    log('>>> 未配置，跳过直连测试。');
    verdict.gateway = 'skip';
  } else {
    const model = raw.strongModel || raw.lightModel || '';
    const base = /\/v\d+$/.test(baseUrl.replace(/\/+$/, '')) ? baseUrl.replace(/\/+$/, '') : baseUrl.replace(/\/+$/, '') + '/v1';
    const t0 = Date.now();
    try {
      const mr = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + apiKey } });
      if (!mr.ok) throw new Error('HTTP_' + mr.status + ' ' + (await mr.text()).slice(0, 100));
      const md = await mr.json();
      const ids = (md.data || []).map((m) => m.id);
      log('模型清单：HTTP 200 · ' + ids.length + ' 个模型可用');
      if (model && !ids.includes(model)) {
        log('★ 警告：配置的模型「' + model + '」不在可用清单中，调用会失败并降级。');
      }
      const cr = await fetch(base + '/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          model: model || ids[0],
          messages: [{ role: 'user', content: '只回复两个字：可用' }],
          // 推理型模型会把大量 token 消耗在 reasoning 上，取样给足 200 否则拿到空串
          max_tokens: 200, temperature: 0.1,
        }),
      });
      const cd = await cr.json();
      if (!cr.ok) throw new Error('HTTP_' + cr.status + ' ' + JSON.stringify(cd).slice(0, 150));
      log('对话测试：HTTP 200 · ' + (Date.now() - t0) + 'ms · 模型 ' + (model || ids[0]));
      log('回复样本：' + String((cd.choices || [{}])[0]?.message?.content || '').slice(0, 40));
      verdict.gateway = 'ok';
    } catch (e) {
      log('>>> 直连失败：' + e.message);
      verdict.gateway = 'fail';
    }
  }

  // ---------- ② 端到端：真实走一次业务对话 ----------
  log('');
  log('【② 端到端验证】真实发一条求助，看服务返回的 source 字段');
  try {
    const lg = await req('POST', '/api/v1/auth/login', { body: { username: 's001', password: '123456' } });
    if (!lg.json || !lg.json.token) throw new Error('登录失败：' + lg.text.slice(0, 120));
    const token = lg.json.token;

    const se = await req('POST', '/api/v1/sessions', { token, body: { stage: 'requirements' } });
    if (!se.json || !se.json.session) throw new Error('创建会话失败：' + se.text.slice(0, 120));
    const sid = se.json.session.sessionId;
    log('会话已建立：' + sid + ' · 阶段 requirements');

    // 用一个不会命中缓存的独特问句，确保真的打到模型
    const stamp = Date.now().toString().slice(-6);
    const say = '我们的校园二手书交易系统，主要用户是在校大学生，编号' + stamp + '，需求从哪开始理？';
    log('发送：' + say);
    const t0 = Date.now();
    const ms = await req('POST', '/api/v1/sessions/' + sid + '/messages', { token, body: { text: say } });
    if (!ms.json || !ms.json.reply) throw new Error('发言失败：' + ms.text.slice(0, 150));
    const wall = Date.now() - t0;

    const src = ms.json.source || (ms.json.context && ms.json.context.source) || {};
    log('耗时（整轮）：' + wall + 'ms');
    log('source 字段：' + JSON.stringify(src));
    log('');
    if (src.engine === 'llm') {
      log('判定：★ 大模型已生效');
      log('  使用模型：' + src.model + (src.cached ? '（命中缓存，本轮未真实计费）' : '（真实调用）'));
      log('  模型耗时：' + src.modelLatencyMs + 'ms');
      verdict.e2e = 'llm';
    } else if (src.fallback) {
      log('判定：★ 引擎为规则——调用了模型但失败降级');
      log('  错误原因：' + (src.modelError || '未知'));
      log('  等待耗时：' + src.modelLatencyMs + 'ms · 超时阈值 ' + (raw.timeoutMs || 15000) + 'ms');
      log('  建议：调大 timeoutMs，或换更快的轻量模型。');
      verdict.e2e = 'fallback';
    } else if (src.ruleOnly) {
      log('判定：★ 本轮走规则引擎——意图「' + src.intent + '」属于合规专属场景');
      log('  说明：概念讲解 / 报错诊断 / 产出物评审由规则负责，属预期设计，不是故障。');
      verdict.e2e = 'rule-intent';
    } else {
      log('判定：★ 未调用模型' + (src.llmEnabled === false ? '（开关未开或 Key 未配置）' : ''));
      verdict.e2e = 'rule';
    }

    const txt = String(ms.json.reply.text || '');
    log('');
    log('回复首 120 字：');
    log('  ' + txt.slice(0, 120).replace(/\n/g, ' '));
  } catch (e) {
    log('>>> 端到端验证失败：' + e.message);
    log('    服务是否启动？可在 zhitu/ 下运行 npm start。');
    verdict.e2e = 'fail';
  }

  // ---------- ③ 留痕核对 ----------
  log('');
  log('【③ 调用留痕核对】');
  try {
    const lg = await req('POST', '/api/v1/auth/login', { body: { username: 'admin', password: '123456' } });
    if (!lg.json || !lg.json.token) throw new Error('管理员登录失败');
    const cl = await req('GET', '/api/v1/admin/llm/calls?limit=5', { token: lg.json.token });
    if (!cl.json) throw new Error('查询失败');
    const st = cl.json.stat || {};
    log('累计调用 ' + (st.total || 0) + ' 次 · 大模型 ' + (st.llmCalls || 0) + ' 次 · 降级 ' + (st.fallbacks || 0) +
        ' 次 · 缓存 ' + (st.cached || 0) + ' 次');
    log('累计 token：提示 ' + (st.pt || 0) + ' / 生成 ' + (st.ct || 0));
    (cl.json.items || []).slice(0, 5).forEach((c) => {
      log('  ' + c.created_at + '  ' + (c.engine === 'llm' ? 'LLM ' : 'RULE') + '  ' +
          (c.model || '-') + '  ' + (c.latency_ms || 0) + 'ms  ' +
          (c.fallback ? '降级' : c.cached ? '缓存' : '') + '  ' + (c.student_id || ''));
    });
    if (st.llmCalls > 0 && (st.pt + st.ct) > 0) {
      verdict.calls = 'ok';
      log('>>> 存在真实模型消耗，大模型确实在工作。');
    } else if (st.total > 0) {
      verdict.calls = 'no-token';
      log('>>> 有调用记录但无模型 token 消耗，当前实际运行在规则引擎上。');
    } else {
      verdict.calls = 'empty';
      log('>>> 无任何调用记录。');
    }
  } catch (e) {
    log('>>> 留痕核对失败：' + e.message);
    verdict.calls = 'fail';
  }

  // ---------- 结论 ----------
  log('');
  let final;
  if (verdict.e2e === 'llm' && verdict.calls !== 'no-token') {
    final = 'VERDICT: APPLIED — 大模型已生效';
  } else if (verdict.e2e === 'fallback') {
    final = 'VERDICT: DEGRADED — 配了模型但降级回规则引擎，需调 timeout/换轻量模型';
  } else if (verdict.e2e === 'rule-intent') {
    final = 'VERDICT: PARTIAL — 系统已接模型，但该意图走规则（合规场景），换一句开放提问再测';
  } else {
    final = 'VERDICT: NOT_APPLIED — 仍在规则引擎，检查 data/llm.json 的 enabled 与 apiKey';
  }
  log('════════════════════════════════════════');
  log(final);
  log('════════════════════════════════════════');
  log('');
  log('其它判定入口：');
  log('  · 学生端界面：每条回复下方有来源标签（大模型 · 模型名 · 耗时 / 规则引擎），顶栏常驻指示');
  log('  · 管理端「模型与成本」→ 模型调用留痕：逐条看 engine / model / token');
  log('  · 直接问：' + BASE + '/api/v1/health');

  fs.writeFileSync(OUT, lines.join(os.EOL), 'utf8');
})().catch((e) => {
  const msg = '验证脚本异常：' + e.message;
  lines.push(msg);
  try { fs.writeFileSync(OUT, lines.join(os.EOL), 'utf8'); } catch (_) { /* ignore */ }
  console.error(msg);
  process.exit(1);
});
