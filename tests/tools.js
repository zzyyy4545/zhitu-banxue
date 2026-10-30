'use strict';
/**
 * M2 工具层专项测试：静态检查 / 单测执行 / Git 提交轨迹 / 权限与留痕
 * 用法：node tests/tools.js（由 tests/run.js 拉起服务后执行）
 */
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.ZHITU_BASE || 'http://127.0.0.1:3000';
const REPORT = path.join(__dirname, '_tools_report.txt');

async function api(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
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

// ---- 测试样本 ----
const BAD_CODE = [
  'function getData(list) {',
  '  var temp = null;',
  '  var flag = false;',
  '  for (var i = 0; i < list.length; i++) {',
  '    for (var j = 0; j < list.length; j++) {',
  '      for (var k = 0; k < list.length; k++) {',
  '        for (var m = 0; m < list.length; m++) {',
  '          if (list[m]) { console.log(list[m]); }',
  '        }',
  '      }',
  '    }',
  '  }',
  '  debugger;',
  '  return temp;',
  '}',
].join('\n');

const PASSING_TEST = [
  "const { test } = require('node:test');",
  "const assert = require('node:assert');",
  '',
  "test('两数相加', () => {",
  "  assert.equal(1 + 1, 2);",
  '});',
  '',
  "test('字符串包含', () => {",
  "  assert.ok('abc'.includes('b'));",
  '});',
].join('\n');

const FAILING_TEST = [
  "const { test } = require('node:test');",
  "const assert = require('node:assert');",
  '',
  "test('会通过的用例', () => {",
  "  assert.equal(2 * 2, 4);",
  '});',
  '',
  "test('会失败的用例', () => {",
  "  assert.equal(2 * 2, 5);",
  '});',
].join('\n');

const TIMEOUT_TEST = [
  "const { test } = require('node:test');",
  '',
  "test('死循环', () => {",
  '  while (true) {}',
  '});',
].join('\n');

async function main() {
  const tS = (await api('POST', '/api/v1/auth/login', { username: 's001', password: '123456' })).token;
  const tT = (await api('POST', '/api/v1/auth/login', { username: 'teacher', password: '123456' })).token;
  check('登录（学生/教师）', !!(tS && tT), { ok: true });

  // ---- 1 静态检查 ----
  const sc = await api('POST', '/api/v1/tools/static-check', {
    code: BAD_CODE, filename: 'order.service.js',
  }, tS);
  const rules = new Set(sc.issues.map((i) => i.rule));
  check('静态检查：命中调试残留 / 命名 / 嵌套过深',
    sc.issues.length >= 3 && rules.has('SC_CONSOLE') && rules.has('SC_NAMING') && rules.has('SC_DEEP_NEST'),
    { total: sc.summary.totalIssues, rules: [...rules] });
  check('静态检查：问题带行号与规范条目',
    sc.issues.every((i) => i.line > 0 && i.guidance && i.severity),
    { sample: { rule: sc.issues[0].rule, line: sc.issues[0].line, guidance: sc.issues[0].guidance.slice(0, 20) + '…' } });
  check('静态检查红线：不输出修复后代码（无 fixedCode 字段，正文无完整修复实现）',
    sc.fixedCode === undefined && !/修复后的完整代码/.test(JSON.stringify(sc)),
    { note: sc.note.slice(0, 30) + '…' });
  check('静态检查留痕（tool_runs）',
    !!sc.runId,
    { runId: sc.runId });

  const scClean = await api('POST', '/api/v1/tools/static-check', {
    code: 'const orderId = 123;\nfunction calcTotalPrice(qty, unitPrice) {\n  return qty * unitPrice;\n}\nmodule.exports = { calcTotalPrice };\n',
    filename: 'order.js',
  }, tS);
  check('静态检查：干净代码 0 问题（不误报）',
    scClean.issues.length === 0,
    { issues: scClean.issues.map((i) => i.rule) });

  // ---- 2 单测执行 ----
  const utPass = await api('POST', '/api/v1/tools/run-tests', {
    files: [{ name: 'test.js', content: PASSING_TEST }], entry: 'test.js',
  }, tS);
  check('单测执行：全部通过',
    utPass.ok === true && utPass.pass === 2 && utPass.fail === 0,
    { tests: utPass.tests, pass: utPass.pass, fail: utPass.fail, ms: utPass.durationMs });

  const utFail = await api('POST', '/api/v1/tools/run-tests', {
    files: [{ name: 'test.js', content: FAILING_TEST }], entry: 'test.js',
  }, tS);
  check('单测执行：失败用例被准确报告',
    utFail.ok === false && utFail.fail === 1 && utFail.pass === 1 && /会失败的用例/.test(utFail.failures.map((f) => f.name).join()),
    { pass: utFail.pass, fail: utFail.fail, failures: utFail.failures.map((f) => f.name) });
  check('单测执行红线：不代写测试文件',
    !/测试文件代码|generatedTest/.test(JSON.stringify(utFail)) && !!utFail.note,
    { note: utFail.note.slice(0, 40) + '…' });

  const utTimeout = await api('POST', '/api/v1/tools/run-tests', {
    files: [{ name: 'test.js', content: TIMEOUT_TEST }], entry: 'test.js', timeoutMs: 3000,
  }, tS);
  check('单测执行：死循环被超时强制终止',
    utTimeout.timedOut === true && utTimeout.ok === false,
    { timedOut: utTimeout.timedOut, durationMs: utTimeout.durationMs });

  // ---- 3 Git：手工导入 + 分析 ----
  const gid = 'SE-2026-A-G01';
  const nowMs = Date.now();
  // SHA 每次运行唯一，保证测试可重复执行（导入去重按 group+sha）
  const pfx = 't' + nowMs.toString(16).slice(-6);
  const importRows = [
    { sha: pfx + '1', date: new Date(nowMs - 9 * 24 * 3600000).toISOString(), author: '赵一鸣', message: 'feat: 新增按课程搜索接口，因为验收标准要求3秒内返回' },
    { sha: pfx + '2', date: new Date(nowMs - 7 * 24 * 3600000).toISOString(), author: '赵一鸣', message: 'fix: 修复空结果白屏，因为空数组没走占位分支' },
    { sha: pfx + '3', date: new Date(nowMs - 5 * 24 * 3600000).toISOString(), author: '钱子涵', message: '修改' },
    { sha: pfx + '4', date: new Date(nowMs - 2 * 24 * 3600000).toISOString(), author: '钱子涵', message: 'update' },
  ];
  const imp = await api('POST', '/api/v1/teacher/git/import', { groupId: gid, raw: JSON.stringify(importRows) }, tT);
  check('Git 手工导入：JSON 格式解析入库',
    imp.imported === 4 && imp.inserted >= 1,
    { imported: imp.imported, inserted: imp.inserted });

  const impDup = await api('POST', '/api/v1/teacher/git/import', { groupId: gid, raw: JSON.stringify(importRows) }, tT);
  check('Git 导入去重：同 sha 重复导入不重复计数',
    impDup.inserted === 0,
    { imported: impDup.imported, inserted: impDup.inserted });

  const lineImp = await api('POST', '/api/v1/teacher/git/import', {
    groupId: 'SE-2026-A-G02',
    raw: pfx + 'a|' + new Date(nowMs - 3 * 24 * 3600000).toISOString().slice(0, 10) + '|孙思远|feat: 加入到货订阅提醒，因为故事卡约定无结果时给出订阅入口\n' +
      pfx + 'b|' + new Date(nowMs - 8 * 3600000).toISOString().slice(0, 10) + '|孙思远|fix',
  }, tT);
  check('Git 手工导入：竖线分隔格式解析',
    lineImp.imported === 2,
    { imported: lineImp.imported });

  const ga = await api('GET', '/api/v1/teacher/git/groups/' + encodeURIComponent(gid) + '/commits', null, tT);
  const a = ga.analysis;
  check('Git 分析：提交频次与间隔方差口径（5.2）',
    a.count >= 4 && a.activeDays >= 3 && a.perDay > 0 && a.intervalVarianceH >= 0,
    { count: a.count, activeDays: a.activeDays, perDay: a.perDay, varianceH: a.intervalVarianceH });
  check('Git 分析：低信息提交信息被标记（编码阶段同源判据）',
    a.lowInfoMessages >= 2,
    { lowInfo: a.lowInfoMessages, ratio: a.lowInfoRatio });
  check('Git 分析：成员分布只列事实（有作者名与次数，无评分字段）',
    a.members.length >= 2 && a.members.every((m) => m.count > 0 && m.author) && a.members.every((m) => m.score === undefined),
    { members: a.members.map((m) => m.author + ':' + m.count) });

  const ana = await api('GET', '/api/v1/teacher/git/analysis', null, tT);
  const g1 = ana.groups.find((g) => g.groupId === gid);
  check('Git 看板：班级维度汇总含风险组与未接入组',
    ana.totals.groups > 0 && ana.totals.withGit > 0 && !!g1,
    { groups: ana.totals.groups, withGit: ana.totals.withGit, commits: ana.totals.commits });

  // ---- 4 Git 平台同步降级 ----
  const reg = await api('POST', '/api/v1/teacher/git/repos', {
    groupId: gid, platform: 'gitea', url: 'http://127.0.0.1:9/git/nonexistent/repo.git',
  }, tT);
  const syncBad = await api('POST', '/api/v1/teacher/git/repos/' + reg.repoId + '/sync', {}, tT);
  check('Git 同步降级：平台不可达时标记 unreachable 而非崩溃（9.2 故障演练）',
    syncBad.ok === false && !!syncBad.error,
    { error: String(syncBad.error).slice(0, 60) });

  let badPlatform = false;
  try { await api('POST', '/api/v1/teacher/git/repos', { groupId: gid, platform: 'svn', url: 'https://x' }, tT); }
  catch (e) { badPlatform = /platform/.test(e.message); }
  check('Git 登记：不支持的平台被拒绝', badPlatform, { rejected: badPlatform });

  // ---- 5 学生可见性与权限 ----
  const sg = await api('GET', '/api/v1/student/git', null, tS);
  check('学生可查看本组提交轨迹（透明原则）',
    sg.hasGroup === true && sg.analysis.count >= 4,
    { count: sg.analysis.count, rhythms: sg.analysis.rhythms.length });

  let forbidden = false;
  try { await api('GET', '/api/v1/teacher/git/analysis', null, tS); }
  catch (e) { forbidden = /无权/.test(e.message); }
  check('学生无权访问教师 Git 接口', forbidden, { rejected: forbidden });

  const runs = await api('GET', '/api/v1/tools/my-runs', null, tS);
  check('工具使用留痕：学生可见自己的运行记录',
    runs.runs.length >= 3 && runs.runs.some((r) => r.tool === 'static') && runs.runs.some((r) => r.tool === 'unittest'),
    { runs: runs.runs.length, tools: [...new Set(runs.runs.map((r) => r.tool))] });

  // ---- 6 主链路集成：编码阶段贴代码块自动附静态检查 ----
  const s = await api('POST', '/api/v1/sessions', { stage: 'coding' }, tS);
  const mr = await api('POST', `/api/v1/sessions/${s.session.sessionId}/messages`, {
    text: '我写了这段函数，帮我看看哪里有问题：\n```\nfunction getData(list) {\n  var temp = null;\n  console.log(temp);\n  return temp;\n}\n```\n\n不知道哪里不合适。',
  }, tS);
  check('主链路集成：编码阶段贴代码块自动附「工具检查」摘要（FR-104 ④）',
    /工具检查（静态检查）/.test(mr.reply.text) && /console\.log|调试残留/.test(mr.reply.text),
    { hasSummary: /工具检查（静态检查）/.test(mr.reply.text), level: mr.reply.level });
  check('主链路集成：摘要只含问题清单，不含修复代码',
    !/你可以这样写/.test(mr.reply.text),
    { guarded: mr.context.guard });

  // ---- 7 M2 深化：规则目录 / 新规则 / 降噪开关 ----
  const cat = await api('GET', '/api/v1/tools/static-rules', null, tS);
  check('M2深化：规则目录接口（≥15 条，含级别与规范条目）',
    cat.rules.length >= 15 && cat.rules.every((r) => r.code && r.name && r.severity && r.guidance),
    { count: cat.rules.length });

  const BAD2 = [
    'var total = 0;',
    'if (total == "5") { alert("x"); }',
    'if (total > 37.5) { total = 1; }',
    'try { run(); } catch (e) {}',
    'eval("code");',
    'function process(a, b, c, d, e, f) { return a; }',
    'function process(a, b) { return a; }',
  ].join('\n');
  const sc2 = await api('POST', '/api/v1/tools/static-check', { code: BAD2, filename: 'bad2.js' }, tS);
  const got2 = new Set(sc2.issues.map((i) => i.rule));
  const EXPECT2 = ['SC_VAR', 'SC_LOOSE_EQ', 'SC_ALERT', 'SC_MAGIC_NUM', 'SC_EMPTY_CATCH', 'SC_EVAL', 'SC_LONG_PARAMS', 'SC_DUP_FN'];
  check('M2深化：新增 8 条规则全部命中（var/松散相等/alert/魔法数字/空catch/eval/长参数/重名函数）',
    EXPECT2.every((c) => got2.has(c)),
    { hit: EXPECT2.filter((c) => got2.has(c)).length + '/8' });
  check('M2深化：问题带列号定位',
    sc2.issues.every((i) => i.line > 0) && sc2.issues.some((i) => i.col > 0),
    { withCol: sc2.issues.filter((i) => i.col > 0).length });

  const sc3 = await api('POST', '/api/v1/tools/static-check', {
    code: BAD2, filename: 'bad2.js', disabled: ['SC_VAR', 'SC_EVAL'],
  }, tS);
  const got3 = new Set(sc3.issues.map((i) => i.rule));
  check('M2深化：降噪开关——禁用规则不再报，其余照报',
    !got3.has('SC_VAR') && !got3.has('SC_EVAL') && got3.has('SC_ALERT') && sc3.summary.rulesApplied < sc3.summary.rulesTotal,
    { applied: sc3.summary.rulesApplied + '/' + sc3.summary.rulesTotal });

  const scStrict = await api('POST', '/api/v1/tools/static-check', {
    code: 'let n = 3;\nif (n === 3 && n !== 4 && n > 0 && n < 100) { return; }\n', filename: 'strict.js',
  }, tS);
  check('M2深化：严格相等与惯用数字不误报',
    scStrict.issues.length === 0,
    { issues: scStrict.issues.map((i) => i.rule) });

  // ---- 8 M2 深化：单测逐用例明细与行号提示 ----
  const utFail2 = await api('POST', '/api/v1/tools/run-tests', {
    files: [{ name: 'test.js', content: FAILING_TEST }], entry: 'test.js',
  }, tS);
  check('M2深化：单测逐用例明细（cases 含名称与通过标记）',
    Array.isArray(utFail2.cases) && utFail2.cases.length === 2 &&
      utFail2.cases.some((c) => c.ok) && utFail2.cases.some((c) => !c.ok),
    { cases: utFail2.cases.map((c) => c.name + (c.ok ? '✓' : '✗')) });
  check('M2深化：失败用例附源码位置提示（hints 指向自己的文件行号）',
    utFail2.failures.every((f) => Array.isArray(f.hints)) &&
      utFail2.failures.some((f) => (f.hints || []).some((h) => /^test\.js:\d+$/.test(h))),
    { hints: utFail2.failures.map((f) => (f.hints || []).join(',')) });

  // ---- 9 M2 深化：Git 分析新维度 ----
  const ga2 = await api('GET', '/api/v1/teacher/git/groups/' + encodeURIComponent(gid) + '/commits', null, tT);
  const a2 = ga2.analysis;
  check('M2深化：提交信息规范分析（类型分布 + Conventional 符合率）',
    !!a2.messageQuality && !!a2.messageQuality.typeDistribution &&
      (a2.messageQuality.typeDistribution.feat || 0) >= 1 &&
      typeof a2.messageQuality.conventionalRatio === 'number',
    { types: a2.messageQuality.typeDistribution, ratio: a2.messageQuality.conventionalRatio });
  check('M2深化：时段分布直方图（24 小时 + 深夜占比）',
    Array.isArray(a2.hourHistogram.hours) && a2.hourHistogram.hours.length === 24 &&
      typeof a2.hourHistogram.lateNightRatio === 'number' && a2.hourHistogram.hours.reduce((x, y) => x + y, 0) === a2.count,
    { peakHour: a2.hourHistogram.peakHour, lateNightRatio: a2.hourHistogram.lateNightRatio });
  check('M2深化：成员明细（活跃天/首末提交/低信息率，仍无评分字段）',
    a2.members.length >= 2 && a2.members.every((m) => m.activeDays > 0 && m.firstCommitAt && m.lastCommitAt && typeof m.lowInfoRatio === 'number') &&
      a2.members.every((m) => m.score === undefined),
    { sample: { author: a2.members[0].author, activeDays: a2.members[0].activeDays } });

  const future = new Date(Date.now() + 365 * 86400000).toISOString().slice(0, 10);
  const gaFuture = await api('GET', '/api/v1/teacher/git/groups/' + encodeURIComponent(gid) + '/commits?from=' + future, null, tT);
  check('M2深化：日期区间筛选（未来日期 → 0 条）',
    gaFuture.analysis.count === 0 && gaFuture.analysis.range.from === future,
    { from: future, count: gaFuture.analysis.count });

  const rpt = await api('GET', '/api/v1/teacher/git/report?groupId=' + encodeURIComponent(gid), null, tT);
  check('M2深化：分析报告导出（JSON 含结构与红线声明）',
    !!rpt.text && /提交轨迹分析报告/.test(rpt.text) && /不评分/.test(rpt.text) &&
      !!rpt.analysis && rpt.analysis.count >= 4,
    { textLen: rpt.text.length, generatedAt: rpt.generatedAt });

  // ---- 报告 ----
  const pass = results.filter((r) => r.pass).length;
  const lines = [];
  lines.push('===== M2 工具层专项测试报告 =====');
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
