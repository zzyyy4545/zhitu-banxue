'use strict';
/**
 * M3 专项测试：团队协同（站会/角色扮演/互评/复盘）、周报、推送通道、多端同步、成本治理
 * 用法：node tests/m3.js（由 tests/run.js 拉起服务后执行）
 */
const path = require('node:path');

const BASE = process.env.ZHITU_BASE || 'http://127.0.0.1:3000';
const REPORT = path.join(__dirname, '_m3_report.txt');

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
  if (!res.ok) {
    const e = new Error(`${method} ${url} → ${res.status} ${data.error || text.slice(0, 120)}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

/** 不抛错版本：返回 {status, data}，用于断言 4xx 拒绝路径 */
async function rawApi(method, url, body, token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const results = [];
function check(name, pass, detail) { results.push({ name, pass, detail }); }

(async () => {
  /* ---------- 登录 ---------- */
  const tS = await api('POST', '/api/v1/auth/login', { username: 's001', password: '123456' });
  const tT = await api('POST', '/api/v1/auth/login', { username: 'teacher', password: '123456' });
  const sTok = tS.token;
  const tTok = tT.token;
  const me = await api('GET', '/api/v1/open/me', null, sTok);
  const groupId = me.student.groupId;
  const myName = me.student.name;

  /* ---------- 1 站会（FR-301） ---------- */
  // 先导入两条近 24h 提交（作者=本人），保证「提示与 Git 提交数据一致」可断言
  const nowMs = Date.now();
  // sha 保持短且全 hex（导入层会清洗非 hex 字符并截断到 12 位，过长的自造 sha 会撞车去重）
  const shas = [0, 1].map((i) => ((nowMs % 0x10000000) + i).toString(16));
  await api('POST', '/api/v1/teacher/git/import', {
    groupId,
    raw: shas.map((s, i) =>
      `${s}|${new Date(nowMs - (i + 1) * 3600000).toISOString().slice(0, 10)}|${myName}|feat: 站会验证提交${i}，因为验收要求`
    ).join('\n'),
  }, tTok);

  const su = await api('POST', '/api/v1/team/standups', {}, sTok);
  check('站会-创建/取回当日站会', !!su.standupId && su.groupId === groupId, 'standupId=' + su.standupId);

  const myFact = (su.prompt.facts || []).find((f) => f.name === myName) || {};
  check('站会-提示含 Git 事实（近48h提交≥2 且信息可对照）',
    (myFact.commits48h || 0) >= 2 && JSON.stringify(myFact.recentMessages || []).includes('站会验证提交'),
    'commits48h=' + myFact.commits48h);
  check('站会-三问齐全', (su.prompt.questions || []).length === 3, JSON.stringify(su.prompt.questions || []).slice(0, 80));

  // 空泛回答 → 被追问；阻碍 → 落待办 + 教师端可见
  const a1 = await api('POST', `/api/v1/team/standups/${su.standupId}/answer`,
    { yesterday: '还行', today: '正常', blocker: '接口字段约定与前端不一致，联调一直报错' }, sTok);
  check('站会-空泛回答被追问（不代填、逼具体）', a1.vague === 1 && /空泛|具体/.test(a1.followUp), a1.followUp.slice(0, 40));

  const todos = await api('GET', '/api/v1/team/todos', null, sTok);
  const blockerTodo = todos.todos.find((t) => t.text.includes('接口字段约定'));
  check('站会-阻碍 100% 落入待办', !!blockerTodo && blockerTodo.status === 'open', blockerTodo ? blockerTodo.text.slice(0, 40) : '未找到');

  const ov = await api('GET', '/api/v1/teacher/team/overview', null, tTok);
  const myGroupOv = ov.groups.find((g) => g.groupId === groupId) || {};
  check('站会-阻碍同步教师端（团队观察可见）', (myGroupOv.blockers || 0) >= 1, 'blockers=' + myGroupOv.blockers);

  // 空答案拒绝（不代填红线）
  const empty = await rawApi('POST', `/api/v1/team/standups/${su.standupId}/answer`, { yesterday: '', today: '', blocker: '' }, sTok);
  check('站会-拒绝空答案（记录必须学生本人填写）', empty.status === 400, 'status=' + empty.status);

  /* ---------- 2 角色扮演（FR-302） ---------- */
  const rp = await api('POST', '/api/v1/team/roleplays', { role: 'customer' }, sTok);
  check('扮演-可开始并给出角色设定', !!rp.id && /客户/.test(rp.scenario), rp.roleName);

  const t1 = await api('POST', `/api/v1/team/roleplays/${rp.id}/turn`, { text: '我想直接开始做，你把需求文档给我吧' }, sTok);
  check('扮演-学生索要成品时角色坚持模糊（不交需求文档）',
    typeof t1.reply === 'string' && t1.clarifying === 0 && !/需求文档|完整需求/.test(t1.reply), t1.reply.slice(0, 40));

  const t2 = await api('POST', `/api/v1/team/roleplays/${rp.id}/turn`, { text: '你们店里大概有多少会员？一个月新增多少？' }, sTok);
  check('扮演-澄清问题计数', t2.clarifying >= 1, 'clarifying=' + t2.clarifying);

  const fin = await api('POST', `/api/v1/team/roleplays/${rp.id}/turn`, { end: true }, sTok);
  check('扮演-结束必给观察反馈且 ≥2 条改进建议',
    fin.ended === true && (fin.feedback.suggestions || []).length >= 2,
    'suggestions=' + (fin.feedback.suggestions || []).length);
  check('扮演-反馈含澄清问题数与遗漏约束维度',
    typeof fin.feedback.clarifying === 'number' && Array.isArray(fin.feedback.missed) && Array.isArray(fin.feedback.covered),
    'clarifying=' + fin.feedback.clarifying + ' missed=' + fin.feedback.missed.length);

  /* ---------- 3 互评（FR-303） ---------- */
  const pf = await api('GET', '/api/v1/team/peer-review/facts', null, sTok);
  const others = pf.members.filter((m) => m.studentId !== me.student.studentId);
  check('互评-事实清单只列事实（无分数无排名字段）',
    others.length > 0 && others.every((m) => m.facts.every((f) => !/分$|排名第|得分/.test(f))),
    'members=' + others.length);

  const rv = await api('POST', '/api/v1/team/peer-review', { revieweeId: others[0].studentId, note: '他这周提交很频繁，每次站会也都按时参加了' }, sTok);
  check('互评-缺影响的空泛评价被追问', rv.vague === 1 && /影响/.test(rv.followUp), rv.followUp.slice(0, 40));

  const rv2 = await api('POST', '/api/v1/team/peer-review', {
    revieweeId: others[0].studentId,
    note: '他这周主动补齐了边界用例，因为等价类划分漏了无效类，直接减少了回归阶段的返工',
  }, sTok);
  check('互评-「行为+影响」句式通过', rv2.ok === true && rv2.vague === 0, 'ok');

  const rv3 = await rawApi('POST', '/api/v1/team/peer-review', {
    revieweeId: others[0].studentId,
    note: '他贡献最大能打 9 分，其他人都不如他，应该排名第一',
  }, sTok);
  check('互评-评分/排名意图被红线拒绝', rv3.status === 400 && /不打分|排名|分数/.test(rv3.data.error || ''), (rv3.data.error || '').slice(0, 50));

  /* ---------- 4 复盘（FR-206） ---------- */
  const bad = await rawApi('POST', '/api/v1/team/retro', { good: '好', improve: '差', action: '改' }, sTok);
  check('复盘-过短正文被拒（系统不代写）', bad.status === 400, 'status=' + bad.status);

  const rt = await api('POST', '/api/v1/team/retro', {
    good: '这轮把验收标准写进故事卡，因为上一轮口头约定导致验收扯皮，这次演示一次通过',
    improve: '接口字段约定靠聊天记录，前端经常要猜，联调拖了两天',
    action: '下个 Sprint 第一天由组长发字段约定表；联调前先过 mock 数据',
  }, sTok);
  check('复盘-生成成长档案（聚合事实）', rt.ok === true && Object.keys(rt.growth || {}).length >= 1, 'growth成员数=' + Object.keys(rt.growth || {}).length);
  check('复盘-补学清单由卡点倒推', Array.isArray(rt.studyList), 'studyList=' + (rt.studyList || []).length);

  const todos2 = await api('GET', '/api/v1/team/todos', null, sTok);
  check('复盘-行动项落入团队待办', todos2.todos.some((t) => t.source === 'retro' && /字段约定/.test(t.text)), 'retro todos=' + todos2.todos.filter((t) => t.source === 'retro').length);

  /* ---------- 5 周报（FR-403） ---------- */
  const wk = await api('GET', '/api/v1/student/weekly', null, sTok);
  check('周报-学生版含求助主题与推进数据',
    Array.isArray(wk.helpTopics) && wk.progress && typeof wk.progress.commits7d === 'number',
    'helps=' + wk.helpTopics.length);

  const wkT = await api('GET', '/api/v1/teacher/weekly', null, tTok);
  const raw = JSON.stringify(wkT);
  check('周报-教师版班级聚合且不含对话原文',
    typeof wkT.helpTotal === 'number' && Array.isArray(wkT.topStuck) && !raw.includes('"content"') && !raw.includes('reply_text'),
    'helpTotal=' + wkT.helpTotal);

  /* ---------- 6 推送通道（FR-503 / 6.2） ---------- */
  const ch = await api('POST', '/api/v1/teacher/push/channels', { name: 'M3测试·站内', type: 'inbox' }, tTok);
  check('推送-可创建站内渠道（降级方案常备）', !!ch.channel.id, ch.channel.name);

  const tst = await api('POST', `/api/v1/teacher/push/channels/${ch.channel.id}/test`, {}, tTok);
  check('推送-站内渠道测试送达', tst.ok === true, JSON.stringify(tst).slice(0, 60));

  const badCh = await rawApi('POST', '/api/v1/teacher/push/channels', { name: '坏渠道', type: 'wecom_webhook', webhook: 'not-a-url' }, tTok);
  check('推送-非法 Webhook 被拒绝', badCh.status === 400, 'status=' + badCh.status);

  // 不可达 webhook：失败不抛异常、留痕可查（9.4 故障演练）
  const chBad = await api('POST', '/api/v1/teacher/push/channels', { name: 'M3测试·不可达', type: 'wecom_webhook', webhook: 'http://127.0.0.1:9/hook' }, tTok);
  const tstBad = await api('POST', `/api/v1/teacher/push/channels/${chBad.channel.id}/test`, {}, tTok);
  check('推送-企微不可达时优雅降级（失败留痕不中断）', tstBad.ok === false && !!tstBad.error, 'error=' + tstBad.error);

  const logs = await api('GET', '/api/v1/teacher/push/logs', null, tTok);
  check('推送-日志与触达统计一致', logs.stats.total >= 2 && logs.stats.ok >= 1 && logs.stats.fail >= 1,
    `total=${logs.stats.total} ok=${logs.stats.ok} fail=${logs.stats.fail}`);

  // 清理测试渠道
  await api('DELETE', `/api/v1/teacher/push/channels/${ch.channel.id}`, null, tTok);
  await api('DELETE', `/api/v1/teacher/push/channels/${chBad.channel.id}`, null, tTok);

  /* ---------- 7 多端同步（FR-404） ---------- */
  const dev1 = await api('POST', '/api/v1/open/devices', { deviceType: 'h5', name: '测试端1' }, sTok);
  check('多端-设备注册换取长期令牌', dev1.deviceToken.startsWith('dt_'), dev1.deviceId.slice(0, 12));

  // 建立会话并产生消息
  const sess = await api('POST', '/api/v1/sessions', { stage: 'requirements', channel: 'web' }, sTok);
  const sid = sess.session.sessionId;
  await api('POST', `/api/v1/open/sessions/${sid}/messages`, { text: '用户故事写到验收标准那里卡住了，不知道怎么写才算可验证' }, dev1.deviceToken);
  await api('POST', `/api/v1/open/sessions/${sid}/messages`, { text: '验收标准里要写什么才算能验证？' }, dev1.deviceToken);

  const s1 = await api('GET', '/api/v1/open/sync?since=0', null, dev1.deviceToken);
  const seqs = s1.messages.map((m) => m.seq);
  check('多端-全量同步按 seq 有序', seqs.length > 0 && seqs.every((v, i) => i === 0 || v > seqs[i - 1]), 'n=' + seqs.length);

  const ids = new Set(s1.messages.map((m) => m.session_id + ':' + m.seq));
  check('多端-消息无重复', ids.size === s1.messages.length, `${ids.size}/${s1.messages.length}`);

  const cursor1 = s1.cursor;
  const more = await api('POST', `/api/v1/open/sessions/${sid}/messages`, { text: '明白了，我试试写成 Given-When-Then' }, dev1.deviceToken);
  const s2 = await api('GET', '/api/v1/open/sync?since=' + cursor1, null, dev1.deviceToken);
  check('多端-增量同步只拉新消息', s2.messages.length >= 2 && s2.messages.every((m) => m.seq > cursor1),
    'new=' + s2.messages.length);
  check('多端-端侧发消息走同一 pipeline（有智能体回复）', !!more.reply && !!more.context, 'level=' + (more.session.level));

  // 第二台设备：从 0 同步 → 与第一台一致（离线补收路径同一条）
  const dev2 = await api('POST', '/api/v1/open/devices', { deviceType: 'miniprogram', name: '测试端2·小程序' }, sTok);
  const s3 = await api('GET', '/api/v1/open/sync?since=0', null, dev2.deviceToken);
  check('多端-第二端离线补收后与首端一致（有序+无缺漏）',
    s3.messages.length >= s1.messages.length &&
    s3.messages.map((m) => m.seq).every((v, i, a) => i === 0 || v > a[i - 1]) &&
    seqs.every((v) => s3.messages.some((m) => m.seq === v)) &&
    s3.cursor >= s2.cursor,
    `dev2 n=${s3.messages.length} cursor=${s3.cursor}`);

  // 越权隔离：s002 的消息不会出现在 s001 设备的同步流里
  const tS2 = await api('POST', '/api/v1/auth/login', { username: 's002', password: '123456' });
  const sess2 = await api('POST', '/api/v1/sessions', { stage: 'requirements', channel: 'web' }, tS2.token);
  await api('POST', `/api/v1/sessions/${sess2.session.sessionId}/messages`, { text: 's002专属越权探针消息内容xyz' }, tS2.token);
  const s4 = await api('GET', '/api/v1/open/sync?since=0', null, dev1.deviceToken);
  check('多端-同步范围仅限本人会话（越权隔离）',
    !JSON.stringify(s4.messages).includes('s002专属越权探针'),
    'n=' + s4.messages.length);

  /* ---------- 8 成本治理（FR-702） ---------- */
  const cu = await api('GET', '/api/v1/teacher/cost/usage?days=7', null, tTok);
  check('成本-用量看板（调用/缓存/降级/配额）',
    cu.total && typeof cu.total.calls === 'number' && cu.quota && cu.quota.dailyCap > 0 && 'rate' in cu.cache,
    `calls=${cu.total.calls} cap=${cu.quota.dailyCap}`);

  /* ---------- 报告 ---------- */
  const pass = results.filter((r) => r.pass).length;
  const lines = results.map((r) => `${r.pass ? 'PASS' : 'FAIL'} | ${r.name}${r.detail ? ' | ' + r.detail : ''}`);
  lines.push('', `M3 专项：${pass}/${results.length} 通过`);
  require('node:fs').writeFileSync(REPORT, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  process.exit(pass === results.length ? 0 : 1);
})().catch((e) => {
  results.push({ name: '执行异常', pass: false, detail: e.message });
  const lines = results.map((r) => `${r.pass ? 'PASS' : 'FAIL'} | ${r.name}${r.detail ? ' | ' + r.detail : ''}`);
  require('node:fs').writeFileSync(REPORT, lines.join('\n'), 'utf8');
  console.error(lines.join('\n'));
  process.exit(1);
});
