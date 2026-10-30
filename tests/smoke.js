'use strict';
/**
 * 端到端冒烟测试：六阶段导学流程 + 教师端驾驶舱 + 管理端接口
 * 用法：node tests/smoke.js
 */
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.ZHITU_BASE || 'http://127.0.0.1:3000';
const REPORT = path.join(__dirname, '_smoke_report.txt');

let tS, tT, tA;

async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    // 接入真实模型后单轮含网关推理（冷启动可达 20s+），超时阈值放宽到 60s
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { __raw: text }; }
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${data.error || text.slice(0, 120)}`);
  return data;
}

const results = [];
function check(name, pass, detail) { results.push({ name, pass, detail }); }

async function main() {
  tS = (await api('POST', '/api/v1/auth/login', { username: 's002', password: '123456' })).token;
  tT = (await api('POST', '/api/v1/auth/login', { username: 'teacher', password: '123456' })).token;
  tA = (await api('POST', '/api/v1/auth/login', { username: 'admin', password: '123456' })).token;
  check('登录（学生/教师/管理员）', !!(tS && tT && tA), { ok: true });

  // ---- 1 需求澄清全流程 ----
  const s = await api('POST', '/api/v1/sessions', { stage: 'requirements' }, tS);
  const sid = s.session.sessionId;
  check('创建会话（FR-101 上下文定位）',
    s.session.stage === 'requirements' && !!s.context.stageName && s.session.capLevel >= 1,
    { stage: s.session.stage, cap: s.session.capLevel, node: s.session.nodeId });

  const flow = [
    { text: '主要是买家，买不到便宜教材', expect: 'pain' },
    { text: '想买但找不到这本书，没人上架', expect: 'story' },
    { text: '作为大二本科生，我想按课程搜索二手教材，以便省下每学期几百块买书的钱', expect: 'acceptance' },
    { text: '1. 输入课程名后3秒内返回匹配结果；2. 若结果为0条则显示「暂无上架，可订阅到货提醒」', expect: '__done__' },
  ];
  let node = s.session.nodeId;
  let last = null;
  for (const step of flow) {
    last = await api('POST', `/api/v1/sessions/${sid}/messages`, { text: step.text }, tS);
    node = last.session.nodeId;
    if (node !== step.expect) break;
  }
  check('需求澄清四节点推进（who→pain→story→acceptance→完成）',
    node === '__done__' && last.reply.stageComplete === true,
    { finalNode: node, stageComplete: last.reply.stageComplete });

  const draft = last.session.draft || {};
  check('产出物草稿抽取（角色/动作/价值/验收）',
    !!(draft.role && draft.want && draft.value && draft.acceptance),
    { role: draft.role, want: draft.want, value: draft.value ? '有' : '无', acceptance: draft.acceptance ? '有' : '无' });

  // ---- 2 六阶段均可创建并推进 ----
  const stages = (await api('GET', '/api/v1/stages', null, tS)).stages;
  const stageOk = [];
  for (const st of stages) {
    const ss = await api('POST', '/api/v1/sessions', { stage: st.key }, tS);
    const r = await api('POST', `/api/v1/sessions/${ss.session.sessionId}/messages`,
      { text: '我们组这一步不知道从哪下手' }, tS);
    stageOk.push({ key: st.key, replied: (r.reply.text || '').length > 10, level: r.reply.level, cap: r.context.capLevel });
  }
  check('六阶段均可创建会话并产出导学回复',
    stageOk.length === 6 && stageOk.every((x) => x.replied),
    stageOk);

  // ---- 3 概念精讲 ----
  const concept = await api('GET', '/api/v1/concept?q=INVEST', null, tS);
  check('概念精讲（FR-103 必含自测问题）',
    concept.found === true && /自测/.test(concept.text),
    { found: concept.found, hasQuiz: /自测/.test(concept.text) });

  const missing = await api('GET', '/api/v1/concept?q=区块链智能合约', null, tS);
  check('图谱无此概念时降级提示（不编造）',
    missing.found === false && /没有记录|我不编/.test(missing.text),
    { found: missing.found });

  // ---- 4 报错诊断 ----
  const diag = await api('POST', '/api/v1/sessions', { stage: 'testing' }, tS);
  const dr = await api('POST', `/api/v1/sessions/${diag.session.sessionId}/messages`,
    { text: '跑测试时报 NullPointerException，不知道哪错了' }, tS);
  check('报错诊断思路链（FR-104 现象→原因排序→验证）',
    /可能原因/.test(dr.reply.text) && /验证/.test(dr.reply.text),
    { intent: dr.reply.intent, hasCauses: /可能原因/.test(dr.reply.text) });

  // ---- 5 导出 ----
  const exp = await api('GET', `/api/v1/sessions/${sid}/export`, null, tS);
  check('会话导出 Markdown（FR-109）',
    !!exp.markdown && exp.markdown.includes('导学过程记录') && exp.markdown.includes('卡点列表'),
    { bytes: exp.markdown.length });

  // ---- 6 教师端 ----
  const t0 = Date.now();
  const dash = await api('GET', '/api/v1/teacher/dashboard', null, tT);
  const dashMs = Date.now() - t0;
  check('班级总览看板（FR-501）',
    !!dash.cards && Array.isArray(dash.groups) && dash.groups.length > 0,
    { activeStudents: dash.cards.activeStudents, groups: dash.groups.length, lowShare: dash.levelDistribution.lowShare, ms: dashMs });
  check('看板首屏性能（1200 人规模目标 ≤3s）', dashMs < 3000, { ms: dashMs });

  const heat = await api('GET', '/api/v1/teacher/knowledge-heatmap', null, tT);
  check('知识点热力（FR-502）', Array.isArray(heat.heat) && Array.isArray(heat.uncovered),
    { heat: heat.heat.length, uncovered: heat.uncovered.length });

  const al = await api('GET', '/api/v1/teacher/alerts?status=pending', null, tT);
  check('预警列表（FR-503）', Array.isArray(al.alerts) && al.rules.length >= 4,
    { pending: al.alerts.length, rules: al.rules.length });

  const cl = await api('GET', '/api/v1/teacher/clusters', null, tT);
  check('求助聚类（FR-504）', Array.isArray(cl.clusters) && cl.clusters.length > 0,
    { clusters: cl.clusters.length, top: (cl.topN[0] || {}).title });

  const pol = await api('GET', '/api/v1/teacher/policies', null, tT);
  check('封顶层策略读取（FR-505）', Array.isArray(pol.policies) && !!pol.defaults,
    { policies: pol.policies.length });

  // 非法封顶值应被拒绝
  let rejected = false;
  try { await api('PUT', '/api/v1/teacher/policies', { scope: 'global', stage: 'coding', capLevel: 9 }, tT); }
  catch (e) { rejected = /L1–L4|无限制/.test(e.message); }
  check('封顶层只能取 L1–L4（拒绝「无限制」）', rejected, { rejected });

  const un = await api('GET', '/api/v1/teacher/unlock-requests', null, tT);
  check('解锁审批列表（FR-506）', Array.isArray(un.requests),
    { requests: un.requests.length, pending: un.requests.filter((r) => r.decision === 'pending').length });

  // 审批一条待处理申请
  const pend = un.requests.find((r) => r.decision === 'pending');
  let approved = null;
  if (pend) {
    approved = await api('POST', `/api/v1/unlock-requests/${pend.req_id}/decision`,
      { decision: 'approved', note: '同意', validHours: 24 }, tT);
  }
  check('解锁审批（批准/驳回/转人工 + 有效期）', !pend || (approved && approved.decision === 'approved' && !!approved.validUntil),
    { hasPending: !!pend, decision: approved && approved.decision, validUntil: approved && approved.validUntil });

  const iv = await api('POST', '/api/v1/teacher/intervene',
    { audience: 'all', text: '本周请完成故事卡初稿，有任何卡点随时问我。', confirm: true }, tT);
  // 教师人工干预不受「系统自动触达每日 ≤2 次」配额约束，必须真实送达
  check('一键干预群发（FR-507 需二次确认且真实送达）',
    iv.total > 0 && iv.sent === iv.total && iv.failed === 0,
    { sent: iv.sent, failed: iv.failed, total: iv.total, firstReasons: (iv.failedReasons || []).slice(0, 2) });

  let noConfirm = false;
  try { await api('POST', '/api/v1/teacher/intervene', { audience: 'all', text: 'x', confirm: false }, tT); }
  catch (e) { noConfirm = /二次确认/.test(e.message); }
  check('未二次确认时拒绝发送', noConfirm, { rejected: noConfirm });

  const obe = await api('GET', '/api/v1/teacher/obe-export', null, tT);
  check('OBE 证据导出（FR-508 CSV + Markdown）',
    obe.dims.length >= 5 && !!obe.csv && !!obe.md,
    { dims: obe.dims.length, dist: obe.dist, csvBytes: obe.csv.length });

  const ev = await api('GET', '/api/v1/teacher/students/SE-2026-A-S001/evidence', null, tT);
  check('学术诚信过程证据包（FR-604 仅提示不判定）',
    !!ev.student && Array.isArray(ev.anomalies) && /不判定/.test(ev.note || ''),
    { anomalies: ev.anomalies.length, note: ev.note });

  // ---- 7 管理端 ----
  const ov = await api('GET', '/api/v1/admin/overview', null, tA);
  check('系统概览 / 模型治理状态', !!ov.counts && ov.counts.students > 0,
    { students: ov.counts.students, llmEnabled: ov.llmEnabled });

  const rl = await api('GET', '/api/v1/admin/redline', null, tA);
  check('红线规则库可读（FR-108 可配置）', rl.rules.length >= 5,
    { rules: rl.rules.length });

  const pvs = await api('GET', '/api/v1/admin/prompts', null, tA);
  check('提示词版本库（FR-605）', pvs.versions.length >= 2,
    { versions: pvs.versions.length });

  const au = await api('GET', '/api/v1/admin/audit', null, tA);
  check('审计日志（FR-703）', au.logs.length > 0, { logs: au.logs.length });

  // ---- 8 权限边界 ----
  let forbidden = false;
  try { await api('GET', '/api/v1/admin/overview', null, tS); } catch (e) { forbidden = /无权/.test(e.message); }
  check('学生无权访问管理端接口', forbidden, { rejected: forbidden });

  // ---- 报告 ----
  const pass = results.filter((r) => r.pass).length;
  const lines = [];
  lines.push('===== 端到端冒烟测试报告 =====');
  lines.push(`时间：${new Date().toISOString()}`);
  lines.push(`结果：${pass}/${results.length} 通过`);
  lines.push('');
  for (const r of results) {
    lines.push(`${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}`);
    lines.push('       ' + JSON.stringify(r.detail));
  }
  lines.push('');
  lines.push(pass === results.length ? '>>> 全部通过' : '>>> 存在未通过项');
  const out = lines.join('\n');
  fs.writeFileSync(REPORT, out, 'utf8');
  console.log(out);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('测试执行失败：', e.message);
  process.exit(2);
});
