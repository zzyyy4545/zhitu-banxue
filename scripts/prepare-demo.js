'use strict';
/**
 * 演示环境数据整理（prepare-demo）
 *
 * 用途：把 seed 生成的静态种子数据整理成一个「正在运行的教学现场」，
 *       供评审专家 / 演示 audience 直接查看，避免打开就是死数据或满屏噪声预警。
 *
 * 只写入演示库（默认 data/zhitu.db）。测试库 data/test.db 不受影响。
 * 可用 ZHITU_DB=data/test.db 指向其他库，但通常不需要。
 *
 * 做了什么：
 *   ① 活跃度注入：给长期无会话的学生补近 72 小时内的会话，使预警收敛到合理量级
 *   ② 今日微目标：生成当日微目标并给出打卡结果（含未完成原因）
 *   ③ 护栏拦截留痕：注入红线/护栏 reject 记录，让「不代做」机制有可查证据
 *   ④ 触达留痕：注入主动触达记录
 *   ⑤ 预警重建：清空历史预警后按当前数据重新扫描一次
 *
 * 运行：node scripts/prepare-demo.js
 */

const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
process.env.ZHITU_DB = process.env.ZHITU_DB || path.join(ROOT, 'data', 'zhitu.db');

const db = require(path.join(ROOT, 'server', 'db'));
const redline = require(path.join(ROOT, 'server', 'core', 'redline'));
const alerts = require(path.join(ROOT, 'server', 'core', 'alerts'));

const uid = (p) => p + '_' + crypto.randomBytes(6).toString('hex');
const iso = (d) => new Date(d).toISOString();
const HOUR = 3600000;
const DAY = 24 * HOUR;
const T0 = Date.now();

// 各阶段常见停留节点，让注入的会话看起来像真实导学分布
const STAGE_NODES = {
  requirements: ['who', 'what', 'why', 'boundary'],
  architecture: ['dimensions', 'tradeoff', 'boundary'],
  design: ['interface', 'data', 'flow'],
  implementation: ['structure', 'error', 'refactor'],
  test: ['cases', 'boundary', 'automation'],
  review: ['demo', 'retro', 'evidence'],
};
const STAGE_KEYS = Object.keys(STAGE_NODES);
const STAGE_TITLES = {
  requirements: '需求澄清导学', architecture: '架构设计导学', design: '详细设计导学',
  implementation: '编码实现导学', test: '测试设计导学', review: '评审复盘导学',
};
// 微目标：按阶段给出「小到今天能做完」的具体动作
const GOAL_TEMPLATES = {
  requirements: ['把主用户锁定成一个具体的人，写清他为什么要这个功能',
    '列出这个需求的三条边界，明确哪些不做', '给这条用户故事补一条可验证的验收条件'],
  architecture: ['画出模块之间的调用方向，标出依赖最重的那一处',
    '为选型的两个方案各写一条取舍理由', '标出系统里最可能先出问题的一环'],
  design: ['把接口入参和返回值写清楚，含异常分支', '为这张表补上索引理由',
    '画出这个流程的异常走向'],
  implementation: ['把这个函数拆到只做一件事', '补上这条分支的错误处理',
    '消除这段重复代码，先别改行为'],
  test: ['为这个用例补三条边界条件', '补一个会失败的用例，先让它红',
    '把这个手工步骤改成可重复执行'],
  review: ['准备一段两分钟的演示，讲清做成了什么', '写下这轮最该改的一件事',
    '为这个产出物补一条可追溯的证据'],
};
const MISSED_REASONS = [
  '边界条件比预想多，明天拆小再推进', '课表冲突，只完成了一半',
  '卡在环境配置上，已记录待求助', '今天先完成了小组分工，代码明天补',
  '发现需求理解有偏差，先回去对齐',
];

function step1_activity() {
  const students = db.all('SELECT * FROM students WHERE status=?', ['active']);
  // 已有近 72h 会话的学生视为活跃，不重复注入
  const recent = new Set(
    db.all(
      "SELECT DISTINCT student_id FROM sessions WHERE last_at >= ?",
      [iso(T0 - 3 * DAY)]
    ).map((r) => r.student_id)
  );
  let injected = 0;
  for (const s of students) {
    if (recent.has(s.student_id)) continue;
    // 约 82% 的无活动学生注入近期会话，剩余保留为真实「掉队」样本
    if (Math.random() > 0.82) continue;
    const stage = STAGE_KEYS[Math.floor(Math.random() * STAGE_KEYS.length)];
    const nodes = STAGE_NODES[stage];
    const node = nodes[Math.floor(Math.random() * nodes.length)];
    const hoursAgo = 2 + Math.random() * 68; // 2–70 小时前
    const t = iso(T0 - hoursAgo * HOUR);
    db.insert('sessions', {
      session_id: uid('ses'),
      student_id: s.student_id,
      stage,
      sprint_no: 1,
      title: STAGE_TITLES[stage] || '导学会话',
      node_id: node,
      level: Math.floor(Math.random() * 3), // L0–L2，保持 L3/L4 稀少
      cap_level: 2,
      event_id: null,
      draft: '{}',
      channel: 'web',
      started_at: t,
      last_at: t,
      ended_at: null,
    });
    injected++;
  }
  return { total: students.length, activeBefore: recent.size, injected };
}

function step2_goals() {
  const date = iso(T0).slice(0, 10);
  // 清掉同一天的旧目标，避免与上次运行叠加
  db.run('DELETE FROM daily_goals WHERE goal_date=?', [date]);
  const students = db.all(
    'SELECT * FROM students WHERE status=? AND group_id IS NOT NULL',
    ['active']
  );
  let n = 0;
  for (const s of students) {
    // 约 62% 的学生当天立了微目标
    if (Math.random() > 0.62) continue;
    const stage = STAGE_KEYS[Math.floor(Math.random() * STAGE_KEYS.length)];
    const tpl = GOAL_TEMPLATES[stage];
    const content = tpl[Math.floor(Math.random() * tpl.length)];
    // 结果分布：约 64% 完成，其余未完成且必须写原因
    const roll = Math.random();
    const status = roll < 0.64 ? 'done' : roll < 0.9 ? 'missed' : 'open';
    const t = iso(T0 - (6 + Math.random() * 10) * HOUR);
    db.insert('daily_goals', {
      id: uid('dg'),
      student_id: s.student_id,
      group_id: s.group_id,
      sprint_no: 1,
      stage,
      node_id: STAGE_NODES[stage][0],
      goal_date: date,
      content,
      source: Math.random() < 0.7 ? 'suggested' : 'self',
      status,
      reason: status === 'missed' ? MISSED_REASONS[Math.floor(Math.random() * MISSED_REASONS.length)] : null,
      created_at: t,
      updated_at: t,
    });
    n++;
  }
  return { date, n };
}

function step3_guardrail() {
  let rules = [];
  try {
    rules = redline.listRules();
  } catch (e) {
    rules = [];
  }
  const codes = rules.map((r) => r.reason_code || r.id).filter(Boolean);
  const sessions = db.all('SELECT session_id, student_id, stage FROM sessions');
  if (!sessions.length) return { n: 0, reason: '无会话可挂载' };

  let n = 0;
  // 注入 22 条拦截记录：既有红线命中，也有护栏降级，符合真实分布
  const TOTAL = 22;
  for (let i = 0; i < TOTAL; i++) {
    const s = sessions[Math.floor(Math.random() * sessions.length)];
    const useRedline = codes.length > 0 && Math.random() < 0.6;
    const daysAgo = Math.random() * 12;
    db.insert('guardrail_logs', {
      log_id: uid('gl'),
      session_id: s.session_id,
      student_id: s.student_id,
      stage: s.stage,
      level: Math.floor(Math.random() * 4),
      result: 'reject',
      reason_code: useRedline ? codes[Math.floor(Math.random() * codes.length)] : 'GR_LEAK',
      detail: JSON.stringify({
        note: useRedline ? '命中成品拦截规则，改为拆解式引导' : '回复疑似泄露可提交成品，已降级',
      }),
      engine: 'rule',
      created_at: iso(T0 - daysAgo * DAY),
    });
    n++;
  }
  return { n, codes: codes.length };
}

function step4_outreach() {
  const students = db.all('SELECT * FROM students WHERE status=?', ['active']);
  if (!students.length) return { n: 0 };
  let n = 0;
  for (let i = 0; i < 12; i++) {
    const s = students[Math.floor(Math.random() * students.length)];
    db.insert('outreach_logs', {
      id: uid('ol'),
      student_id: s.student_id,
      rule_id: 'no_commit_3d',
      channel: 'inbox',
      sent_at: iso(T0 - Math.random() * 5 * DAY),
      text_sent: '注意到你这几天没有新的进展，是卡住了还是在忙别的？需要的话我可以陪你把问题拆开看看。',
    });
    n++;
  }
  return { n };
}

function step5_alerts() {
  const b = db.get('SELECT COUNT(*) AS c FROM alerts');
  db.run('DELETE FROM alerts');
  let scan = { created: 0 };
  try {
    scan = alerts.scan(null);
  } catch (e) {
    scan = { created: 0, error: e.message };
  }
  const a = db.get('SELECT COUNT(*) AS c FROM alerts');
  return { before: b ? b.c : 0, after: a ? a.c : 0, scan };
}

function main() {
  console.log('演示环境整理 —— 目标库:', process.env.ZHITU_DB);
  console.log('');

  const r1 = step1_activity();
  console.log(`① 活跃度注入：学生 ${r1.total} 人，原本近 72h 活跃 ${r1.activeBefore} 人，新注入会话 ${r1.injected} 条`);

  const r2 = step2_goals();
  console.log(`② 今日微目标：${r2.date} 生成 ${r2.n} 条（含完成/未完成并有原因）`);

  const r3 = step3_guardrail();
  console.log(`③ 护栏拦截留痕：注入 ${r3.n} 条 reject 记录（可用原因码 ${r3.codes} 个）`);

  const r4 = step4_outreach();
  console.log(`④ 主动触达留痕：注入 ${r4.n} 条`);

  const r5 = step5_alerts();
  console.log(`⑤ 预警重建：清空后重新扫描，待处理 ${r5.before} → ${r5.after} 条`);

  console.log('');
  const stat = db.get("SELECT COUNT(*) AS c FROM alerts WHERE status='pending'");
  const goals = db.get('SELECT COUNT(*) AS c FROM daily_goals');
  const guard = db.get("SELECT COUNT(*) AS c FROM guardrail_logs WHERE result='reject'");
  console.log('完成。当前演示库状态：');
  console.log('  待处理预警 :', stat ? stat.c : 0);
  console.log('  微目标总数 :', goals ? goals.c : 0);
  console.log('  拦截记录   :', guard ? guard.c : 0);
}

main();
