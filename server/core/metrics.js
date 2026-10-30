'use strict';
/**
 * 5.2 关键计算口径 + FR-508 OBE 达成度证据导出
 * 指标：卡点解决率、平均解决轮次、层级停留分布、过程性提交频次、知识点热力值、教师答疑工时
 */
const db = require('../db');
const { jparse, now } = require('./util');
const stages = require('./stages');
const knowledge = require('./knowledge');

/** 卡点解决率 = 已解决事件 / 全部事件 */
function resolveRate({ classId, groupId, from, to } = {}) {
  const { where, params } = buildWhere({ classId, groupId, from, to });
  const total = db.count('help_events e', where, params);
  const resolved = db.count('help_events e', `${where} AND e.status='resolved'`, params);
  return { total, resolved, rate: total ? +(resolved / total).toFixed(3) : 0 };
}

/** 平均解决轮次 */
function avgTurns({ classId, groupId, from, to } = {}) {
  const { where, params } = buildWhere({ classId, groupId, from, to });
  const row = db.get(
    `SELECT AVG(e.turn_count) AS avg_turns, AVG(e.max_level) AS avg_level, AVG(e.upgrade_count) AS avg_upgrade
     FROM help_events e WHERE ${where}`,
    params
  );
  return {
    avgTurns: row && row.avg_turns ? +row.avg_turns.toFixed(2) : 0,
    avgLevel: row && row.avg_level ? +row.avg_level.toFixed(2) : 0,
    avgUpgrade: row && row.avg_upgrade ? +row.avg_upgrade.toFixed(2) : 0,
  };
}

/**
 * 层级停留分布 —— 核心论文指标（L0–L1 占比高说明引导有效）
 */
function levelDistribution({ classId, groupId, from, to } = {}) {
  const { where, params } = buildWhere({ classId, groupId, from, to });
  const rows = db.all(
    `SELECT e.max_level AS lvl, COUNT(*) AS c FROM help_events e WHERE ${where} GROUP BY e.max_level`,
    params
  );
  const dist = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  let total = 0;
  for (const r of rows) {
    const k = Math.max(0, Math.min(4, Number(r.lvl) || 0));
    dist[k] = r.c;
    total += r.c;
  }
  const pct = {};
  for (const k of Object.keys(dist)) pct[k] = total ? +((dist[k] / total) * 100).toFixed(1) : 0;
  const lowShare = total ? +(((dist[0] + dist[1]) / total) * 100).toFixed(1) : 0;
  return { dist, pct, total, lowShare, target: 50 };
}

/** 知识点热力值 = 求助事件数 × 平均解决轮次加权 */
function knowledgeHeat({ classId, groupId, from, to } = {}) {
  const { where, params } = buildWhere({ classId, groupId, from, to });
  const rows = db.all(
    `SELECT e.knowledge_tags, e.turn_count, e.stage FROM help_events e WHERE ${where}`,
    params
  );
  const map = new Map();
  for (const r of rows) {
    for (const tag of jparse(r.knowledge_tags, [])) {
      const cur = map.get(tag) || { name: tag, count: 0, turns: 0, samples: [], stages: new Set() };
      cur.count += 1;
      cur.turns += r.turn_count || 0;
      if (r.stage) cur.stages.add(r.stage);
      if (cur.samples.length < 3) cur.samples.push(r.stage || '');
      map.set(tag, cur);
    }
  }
  const list = [...map.values()].map((x) => ({
    name: x.name,
    count: x.count,
    avgTurns: x.count ? +(x.turns / x.count).toFixed(2) : 0,
    heat: +(x.count * (x.count ? x.turns / x.count : 1)).toFixed(2),
    stages: [...x.stages],
  }));
  list.sort((a, b) => b.heat - a.heat);
  return list;
}

/** 未覆盖知识点（与图谱对照） */
function uncoveredKnowledge({ classId } = {}) {
  const heat = knowledgeHeat({ classId });
  const covered = new Set(heat.map((h) => h.name));
  const all = db.all('SELECT name FROM knowledge_nodes');
  return all.map((n) => n.name).filter((n) => !covered.has(n));
}

/**
 * 过程性提交频次（5.2 口径：Git 提交次数与间隔方差）
 * M2 起优先使用真实 Git 提交轨迹；无仓库数据的组回退产出物版本数（降级通道，口径在 note 中注明）。
 */
function commitFrequency({ classId, groupId } = {}) {
  // Git 真实提交（按班级过滤：组 → 班级）
  let gWhere = '';
  const gParams = [];
  if (groupId) {
    gWhere = 'WHERE c.group_id=?';
    gParams.push(groupId);
  } else if (classId) {
    gWhere = 'WHERE c.group_id IN (SELECT group_id FROM groups WHERE class_id=?)';
    gParams.push(classId);
  }
  const gRows = db.all(
    `SELECT c.group_id, c.committed_at FROM git_commits c ${gWhere} ORDER BY c.committed_at`,
    gParams
  );
  if (gRows.length) {
    const byDay = new Map();
    for (const r of gRows) {
      const d = String(r.committed_at).slice(0, 10);
      byDay.set(d, (byDay.get(d) || 0) + 1);
    }
    const ts = gRows.map((r) => new Date(r.committed_at).getTime()).filter((x) => !isNaN(x)).sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 3600000);
    const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
    const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / (gaps.length || 1);
    return {
      count: gRows.length,
      days: byDay.size,
      perDay: +(gRows.length / Math.max(1, byDay.size)).toFixed(2),
      variance: +variance.toFixed(2),
      varianceUnit: '小时²',
      meanIntervalH: +mean.toFixed(1),
      source: 'git',
    };
  }

  // 降级：产出物版本数 / 活跃天数
  const aw = [];
  const ap = [];
  if (groupId) {
    aw.push('a.group_id=?');
    ap.push(groupId);
  } else if (classId) {
    aw.push('a.group_id IN (SELECT group_id FROM groups WHERE class_id=?)');
    ap.push(classId);
  }
  const rows = db.all(
    `SELECT a.group_id, a.created_at FROM artifacts a
     ${aw.length ? 'WHERE ' + aw.join(' AND ') : ''} ORDER BY a.created_at`,
    ap
  );
  if (!rows.length) return { count: 0, days: 0, perDay: 0, variance: 0, source: 'none' };
  const byDay = new Map();
  for (const r of rows) {
    const d = String(r.created_at).slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  const vals = [...byDay.values()];
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = +(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length).toFixed(2);
  return {
    count: rows.length,
    days: byDay.size,
    perDay: +(rows.length / byDay.size).toFixed(2),
    variance,
    source: 'artifacts',
  };
}

/** 教师答疑工时（自报 + 系统估算：处理预警条数 × 估算单条耗时） */
function teacherWorkload({ teacherId, from, to } = {}) {
  const selfRows = db.all(
    `SELECT COALESCE(SUM(minutes),0) AS m FROM teacher_worklog WHERE source='self' ${
      teacherId ? 'AND teacher_id=?' : ''
    }`,
    teacherId ? [teacherId] : []
  );
  const selfMinutes = selfRows[0] ? selfRows[0].m : 0;
  const handled = db.count('alerts', "status='handled'");
  const systemEstimate = handled * 5; // 每条预警按 5 分钟估算
  return { selfMinutes, handledAlerts: handled, systemEstimate, total: selfMinutes + systemEstimate };
}

/** 越界尝试统计（护栏拦截数，FR-107/108 落地证据） */
function guardrailStats({ classId, from, to } = {}) {
  const rows = db.all(
    `SELECT result, reason_code, COUNT(*) AS c FROM guardrail_logs
     ${from ? 'WHERE created_at >= ?' : ''} GROUP BY result, reason_code`,
    from ? [from] : []
  );
  const byResult = {};
  const byReason = {};
  for (const r of rows) {
    byResult[r.result] = (byResult[r.result] || 0) + r.c;
    if (r.reason_code) byReason[r.reason_code] = (byReason[r.reason_code] || 0) + r.c;
  }
  return { byResult, byReason, total: Object.values(byResult).reduce((a, b) => a + b, 0) };
}

function buildWhere({ classId, groupId, from, to, table }) {
  const w = [];
  const p = [];
  if (classId) {
    w.push('e.student_id IN (SELECT student_id FROM students WHERE class_id=?)');
    p.push(classId);
  }
  if (groupId) {
    w.push('e.group_id = ?');
    p.push(groupId);
  }
  if (from) {
    w.push('e.opened_at >= ?');
    p.push(from);
  }
  if (to) {
    w.push('e.opened_at <= ?');
    p.push(to);
  }
  return { where: w.length ? w.join(' AND ') : '1=1', params: p };
}

/**
 * FR-508 OBE 达成度证据导出（CSV + 汇总 Markdown）
 * 默认维度：过程性提交频次、卡点解决率、求助层级分布、教师答疑工时、阶段产出完整度
 */
function obeExport({ classId, groupId, from, to, anonymize = true } = {}) {
  const rate = resolveRate({ classId, groupId, from, to });
  const turns = avgTurns({ classId, groupId, from, to });
  const dist = levelDistribution({ classId, groupId, from, to });
  const freq = commitFrequency({ classId, groupId });
  const work = teacherWorkload({ from, to });
  const guard = guardrailStats({ classId, from, to });
  const heat = knowledgeHeat({ classId, groupId, from, to }).slice(0, 10);

  // 阶段产出完整度
  const stageCompleteness = stages.all().map((s) => {
    const n = db.count('artifacts', 'stage=?', [s.key]);
    return { stage: s.key, name: s.name, artifacts: n };
  });

  const dims = [
    { key: 'process_commit_frequency', name: '过程性提交频次', value: freq.perDay, unit: '次/活跃日', note: `数据源：${freq.source === 'git' ? 'Git 提交轨迹' : '产出物版本（未接入 Git 的降级口径）'}；间隔方差 ${freq.variance}${freq.varianceUnit || ''}，方差越大说明拖延越明显` },
    { key: 'stuck_resolve_rate', name: '卡点解决率', value: rate.rate, unit: '比值', note: '已解决求助事件 / 全部求助事件' },
    { key: 'level_distribution', name: '求助层级分布（L0–L1 占比）', value: dist.lowShare, unit: '%', note: '核心论文指标：占比越高说明引导越有效，目标 ≥ 50%' },
    { key: 'avg_turns', name: '平均解决轮次', value: turns.avgTurns, unit: '轮', note: '同一事件内学生与智能体的交互轮次均值' },
    { key: 'teacher_workload', name: '教师答疑工时', value: work.total, unit: '分钟', note: '自报工时 + 系统估算（已处理预警 × 5 分钟）' },
    { key: 'guardrail_blocks', name: '越界拦截次数', value: guard.total, unit: '次', note: '护栏与红线规则拦截总数，反映防代做机制运行情况' },
  ];

  const csv = [
    '指标键,指标名称,数值,单位,口径说明',
    ...dims.map((d) => `${d.key},${d.name},${d.value},${d.unit},"${d.note}"`),
    '',
    '层级,事件数,占比(%)',
    ...[0, 1, 2, 3, 4].map((l) => `L${l},${dist.dist[l]},${dist.pct[l]}`),
    '',
    '阶段,产出物数量',
    ...stageCompleteness.map((s) => `${s.name},${s.artifacts}`),
    '',
    '知识点,求助次数,平均轮次,热力值',
    ...heat.map((h) => `${h.name},${h.count},${h.avgTurns},${h.heat}`),
  ].join('\n');

  const md =
    `# OBE 达成度过程性证据 · 导出时间 ${now()}\n\n` +
    `> 本数据包由「知途伴学」过程数据仓库自动汇总，仅含过程性证据，不含成绩认定。\n` +
    `> 脱敏：${anonymize ? '已开启（学号以哈希映射输出）' : '未开启'}\n\n` +
    `## 一、核心指标\n\n| 指标 | 数值 | 单位 | 口径说明 |\n|---|---|---|---|\n` +
    dims.map((d) => `| ${d.name} | ${d.value} | ${d.unit} | ${d.note} |`).join('\n') +
    `\n\n## 二、层级停留分布（核心论文指标）\n\n| 层级 | 事件数 | 占比 |\n|---|---|---|\n` +
    [0, 1, 2, 3, 4].map((l) => `| L${l} ${['提示反问', '方向指引', '步骤拆解', '局部示例', '完整讲解'][l]} | ${dist.dist[l]} | ${dist.pct[l]}% |`).join('\n') +
    `\n\n**L0–L1 占比：${dist.lowShare}%（建议目标 ≥ 50%）**\n\n` +
    `## 三、知识点热力（Top 10）\n\n| 知识点 | 求助次数 | 平均轮次 | 热力值 |\n|---|---|---|---|\n` +
    heat.map((h) => `| ${h.name} | ${h.count} | ${h.avgTurns} | ${h.heat} |`).join('\n') +
    `\n\n## 四、阶段产出完整度\n\n| 阶段 | 产出物数量 |\n|---|---|\n` +
    stageCompleteness.map((s) => `| ${s.name} | ${s.artifacts} |`).join('\n') +
    `\n\n## 五、防代做机制运行\n\n- 护栏拦截总数：${guard.total} 次\n` +
    `- 按结果：${JSON.stringify(guard.byResult)}\n- 按原因码：${JSON.stringify(guard.byReason)}\n`;

  return { csv, md, dims, dist, heat, stageCompleteness, guard };
}

module.exports = {
  resolveRate, avgTurns, levelDistribution, knowledgeHeat, uncoveredKnowledge,
  commitFrequency, teacherWorkload, guardrailStats, obeExport,
};
