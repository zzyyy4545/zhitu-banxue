'use strict';
/**
 * FR-401 学习节拍器
 *
 * 设计要点：
 *   - 基于阶段剧本的剩余节点 + 小组 Sprint，把阶段目标拆解为「每日微目标」；
 *   - 微目标与 Sprint 目标可追溯：每条记录 stage / node_id / sprint_no 来源链；
 *   - 微目标可编辑（学生可改写内容、可自建）；
 *   - 未完成时引导分析原因而非催促进度（验收标准：无催促式话术）。
 */
const db = require('../db');
const stages = require('./stages');
const { uid, now, dayKey } = require('./util');

/** 一天最多自动建议的微目标数（贪多必失，微目标要「微」） */
const MAX_SUGGEST_PER_DAY = 2;

/**
 * 生成/补齐今日微目标（幂等）：
 * 取学生最近一次会话所在阶段的当前节点起，往后取 1–2 个未完成节点作为今日微目标。
 * 已有当日目标（含 manual）时不重复生成，避免打扰。
 */
function ensureToday(student) {
  const date = dayKey();
  const exist = db.all(
    'SELECT * FROM daily_goals WHERE student_id=? AND goal_date=?',
    [student.student_id, date]
  );
  if (exist.length) return { created: 0, goals: decorate(exist) };

  const session = db.get(
    'SELECT * FROM sessions WHERE student_id=? ORDER BY last_at DESC LIMIT 1',
    [student.student_id]
  );
  const group = db.get('SELECT * FROM groups WHERE group_id=?', [student.group_id]);
  const sprintNo = group ? group.sprint_no : (session ? session.sprint_no : 1);
  const stageKey = session ? session.stage : 'requirements';
  const cfg = stages.get(stageKey);
  if (!cfg) return { created: 0, goals: [] };

  let idx = session && session.node_id
    ? cfg.nodes.findIndex((n) => n.id === session.node_id)
    : 0;
  if (session && session.node_id === '__done__') {
    // 阶段已完成：建议进入下一阶段的第一个节点
    const order = stages.all().map((s) => s.key);
    const next = order[(order.indexOf(stageKey) + 1) % order.length];
    return { created: suggest(student, next, stages.get(next).nodes[0].id, 1, sprintNo, date), goals: list(student.student_id).today };
  }
  if (idx < 0) idx = 0;

  const remain = cfg.nodes.slice(idx);
  const take = Math.min(MAX_SUGGEST_PER_DAY, Math.max(1, remain.length));
  const created = suggest(student, stageKey, null, take, sprintNo, date, remain);
  return { created, goals: list(student.student_id).today };
}

function suggest(student, stageKey, onlyNodeId, count, sprintNo, date, remainNodes) {
  const cfg = stages.get(stageKey);
  if (!cfg) return 0;
  const nodes = remainNodes && remainNodes.length
    ? remainNodes.slice(0, count)
    : cfg.nodes.filter((n) => n.id === onlyNodeId);
  let created = 0;
  for (const n of nodes) {
    db.insert('daily_goals', {
      id: uid('dg'),
      student_id: student.student_id,
      group_id: student.group_id || null,
      sprint_no: sprintNo,
      stage: stageKey,
      node_id: n.id,
      goal_date: date,
      content: `${cfg.name} · ${n.title}：${n.goal}`,
      source: 'suggested',
      status: 'open',
      created_at: now(),
      updated_at: now(),
    });
    created++;
  }
  return created;
}

function decorate(rows) {
  return rows.map((r) => ({
    id: r.id,
    date: r.goal_date,
    content: r.content,
    source: r.source,
    status: r.status,
    reason: r.reason || null,
    stage: r.stage,
    stageName: (stages.get(r.stage) || {}).name || r.stage,
    nodeId: r.node_id,
    sprintNo: r.sprint_no,
    updatedAt: r.updated_at,
  }));
}

/** 学生视角：今日 + 近 7 天 + 统计 */
function list(studentId, days = 7) {
  const today = dayKey();
  const rows = db.all(
    `SELECT * FROM daily_goals WHERE student_id=? AND goal_date >= date('now','-${Number(days) || 7} days')
     ORDER BY goal_date DESC, created_at`,
    [studentId]
  );
  const all = decorate(rows);
  const done = all.filter((g) => g.status === 'done').length;
  const missed = all.filter((g) => g.status === 'missed').length;
  const open = all.filter((g) => g.status === 'open').length;
  return {
    today: all.filter((g) => g.date === today),
    recent: all.filter((g) => g.date !== today),
    stats: { done, missed, open, total: all.length },
    note: '微目标由阶段剧本自动拆解，可改写、可自建。没完成不会扣分——我们只分析原因。',
  };
}

/** 学生自建微目标（可编辑性的一部分） */
function add(student, { content, stage, nodeId }) {
  if (!content || !String(content).trim()) {
    throw Object.assign(new Error('微目标内容不能为空'), { status: 400 });
  }
  const session = db.get(
    'SELECT stage FROM sessions WHERE student_id=? ORDER BY last_at DESC LIMIT 1',
    [student.student_id]
  );
  const group = db.get('SELECT sprint_no FROM groups WHERE group_id=?', [student.group_id]);
  const id = uid('dg');
  db.insert('daily_goals', {
    id,
    student_id: student.student_id,
    group_id: student.group_id || null,
    sprint_no: group ? group.sprint_no : 1,
    stage: stage || (session ? session.stage : 'requirements'),
    node_id: nodeId || null,
    goal_date: dayKey(),
    content: String(content).trim(),
    source: 'manual',
    status: 'open',
    created_at: now(),
    updated_at: now(),
  });
  return db.get('SELECT * FROM daily_goals WHERE id=?', [id]);
}

function assertOwn(studentId, goal) {
  if (!goal || goal.student_id !== studentId) {
    throw Object.assign(new Error('微目标不存在'), { status: 404 });
  }
}

/** 编辑内容 */
function update(studentId, id, { content }) {
  const g = db.get('SELECT * FROM daily_goals WHERE id=?', [id]);
  assertOwn(studentId, g);
  if (!content || !String(content).trim()) {
    throw Object.assign(new Error('内容不能为空'), { status: 400 });
  }
  db.update('daily_goals', 'id', id, { content: String(content).trim(), updated_at: now() });
  return { ok: true };
}

/**
 * 打卡：done / missed。
 * missed 必须带原因——引导分析「为什么没完成」，而非催促补进度（FR-401 边界）。
 */
function checkin(studentId, id, { status, reason }) {
  const g = db.get('SELECT * FROM daily_goals WHERE id=?', [id]);
  assertOwn(studentId, g);
  if (!['done', 'missed'].includes(status)) {
    throw Object.assign(new Error('status 只能取 done / missed'), { status: 400 });
  }
  if (status === 'missed' && !reason) {
    throw Object.assign(new Error('标记未完成时请写一句原因——是目标拆大了，还是中间有一步比预想难？'), { status: 400 });
  }
  db.update('daily_goals', 'id', id, { status, reason: reason || null, updated_at: now() });
  return {
    ok: true,
    status,
    // 无催促话术：未完成时只做归因引导
    feedback: status === 'done'
      ? { text: '完成了一个微目标。明天的目标会基于当前进度重新拆解——不用赶，保持这个粒度就好。', kind: 'ok' }
      : {
          text: '记录下来了，不催进度。我们看原因：「' + String(reason).slice(0, 60) +
            '」。如果目标是拆大了，明天就拆小一半；如果是某一步比预想难，把那一步带到对话里，我们先解决它。',
          kind: 'guide',
        },
  };
}

/** 教师端：某组（或全班）今日微目标完成情况 */
function groupToday(groupId, classId) {
  const rows = db.all(
    `SELECT g.*, s.name AS student_name FROM daily_goals g
     LEFT JOIN students s ON s.student_id = g.student_id
     WHERE g.goal_date=? ${groupId ? 'AND g.group_id=?' : ''} ${classId ? 'AND s.class_id=?' : ''}
     ORDER BY g.group_id, s.student_id LIMIT 300`,
    [dayKey(), ...(groupId ? [groupId] : []), ...(classId ? [classId] : [])]
  );
  return {
    date: dayKey(),
    goals: decorate(rows).map((g, i) => ({ ...g, studentName: rows[i].student_name })),
    stats: {
      total: rows.length,
      done: rows.filter((r) => r.status === 'done').length,
      missed: rows.filter((r) => r.status === 'missed').length,
      open: rows.filter((r) => r.status === 'open').length,
    },
  };
}

module.exports = { ensureToday, list, add, update, checkin, groupToday, MAX_SUGGEST_PER_DAY };
