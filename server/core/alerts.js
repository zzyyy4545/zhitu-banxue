'use strict';
/**
 * FR-402 主动触达规则引擎 + FR-503 预警规则配置与推送
 *
 * 边界：同一学生每日主动触达 ≤ 2 次；22:00–08:00 静默（可配置）；任意触达可在学生端关闭。
 * 同类预警 24 小时内合并，不重复打扰。
 */
const db = require('../db');
const { uid, now, hoursBetween, dayKey } = require('./util');

/** 默认规则（说明书 3.4 表） */
const DEFAULT_RULES = [
  {
    id: 'deadline_48h',
    name: '临近交付节点未完成',
    threshold: 48,
    unit: 'hours',
    audience: 'student',
    action: '推送一次「当前卡在哪一步」的引导消息',
    configurable: true,
    text: '距离本轮交付还有不到 48 小时。先别急着赶，我问一句：你现在卡在哪一步？说具体一点，我们只解决那一步。',
  },
  {
    id: 'no_commit_3d',
    name: '连续无提交',
    threshold: 3,
    unit: 'days',
    audience: 'student',
    action: '推送轻量确认消息，非催促语气',
    configurable: true,
    text: '有几天没看到你的动态了。不是催进度——只是想确认一下：是卡住了，还是在忙别的？说一声我就知道怎么帮你。',
  },
  {
    id: 'same_point_3',
    name: '同一卡点重复求助',
    threshold: 3,
    unit: 'times',
    audience: 'both',
    action: '建议换角度 + 生成教师端提醒',
    configurable: true,
    text: '这个卡点你已经来过三次了。继续在同一条路上试，大概率还是同一个结果——换个角度：如果完全换一种做法，你会怎么做？',
  },
  {
    id: 'silent_5d',
    name: '长期沉默',
    threshold: 5,
    unit: 'days',
    audience: 'student',
    action: '唤醒消息（每周最多 2 次）',
    configurable: true,
    text: '好几天没见你了。项目还在推进吗？如果卡住了，说一声——我们从最小的一步重新开始。',
  },
  {
    id: 'sprint_switch',
    name: 'Sprint 切换',
    threshold: 0,
    unit: 'event',
    audience: 'student',
    action: '推送新阶段导学开场与上一阶段要点回顾',
    configurable: false,
    text: '新的一轮开始了。上一轮你留下的行动项记得先过一遍，然后我们进新阶段。',
  },
];

const QUIET_HOURS = { from: 22, to: 8 };
const DAILY_CAP = 2;

// ---------------- 规则持久化（FR-503/402：阈值教师可改，落 SQLite） ----------------

/** 启动时把默认规则种子进 alert_rules 表（已有数据不覆盖） */
function ensureRuleDefaults() {
  const has = db.count('alert_rules');
  if (has > 0) return { seeded: 0, total: has };
  for (const r of DEFAULT_RULES) {
    db.insert('alert_rules', {
      id: r.id, name: r.name, threshold: r.threshold, unit: r.unit,
      audience: r.audience, action: r.action, text: r.text,
      configurable: r.configurable === false ? 0 : 1, enabled: 1,
      updated_at: now(),
    });
  }
  return { seeded: DEFAULT_RULES.length, total: DEFAULT_RULES.length };
}

/** 读取全部规则（表优先，表缺失时回退默认值，保证离线可用） */
function listRules() {
  try {
    const rows = db.all('SELECT * FROM alert_rules ORDER BY id');
    if (rows.length) {
      return rows.map((r) => ({
        id: r.id, name: r.name, threshold: r.threshold, unit: r.unit,
        audience: r.audience, action: r.action, text: r.text,
        configurable: !!r.configurable, enabled: !!r.enabled,
        updatedBy: r.updated_by || null, updatedAt: r.updated_at || null,
      }));
    }
  } catch (_) {
    /* 表未建时回退 */
  }
  return DEFAULT_RULES.map((r) => ({ ...r, enabled: true }));
}

/** 单条规则（同样带回退） */
function ruleOf(id) {
  try {
    const r = db.get('SELECT * FROM alert_rules WHERE id=?', [id]);
    if (r) {
      return {
        id: r.id, name: r.name, threshold: r.threshold, unit: r.unit,
        audience: r.audience, action: r.action, text: r.text,
        configurable: !!r.configurable, enabled: !!r.enabled,
      };
    }
  } catch (_) {
    /* ignore */
  }
  const d = DEFAULT_RULES.find((x) => x.id === id);
  return d ? { ...d, enabled: true } : null;
}

/** 更新规则阈值 / 文案 / 启停（教师端配置入口） */
function updateRule(id, { threshold, text, enabled }) {
  const cur = db.get('SELECT * FROM alert_rules WHERE id=?', [id]);
  if (!cur) throw Object.assign(new Error('规则不存在：' + id), { status: 404 });
  if (!cur.configurable && threshold !== undefined) {
    throw Object.assign(new Error('该规则为事件型触发，阈值不可调'), { status: 400 });
  }
  const patch = { updated_at: now() };
  if (threshold !== undefined) {
    const n = Number(threshold);
    if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('阈值必须是非负数字'), { status: 400 });
    patch.threshold = n;
  }
  if (text !== undefined && String(text).trim()) patch.text = String(text).trim();
  if (enabled !== undefined) patch.enabled = enabled ? 1 : 0;
  db.update('alert_rules', 'id', id, patch);
  return ruleOf(id);
}

function inQuietHours(d = new Date()) {
  const h = d.getHours();
  return h >= QUIET_HOURS.from || h < QUIET_HOURS.to;
}

function todayCount(studentId) {
  const key = dayKey() + '%';
  // 仅统计系统自动触达；教师人工直发（channel='teacher'）不占用每日配额
  return db.count(
    'outreach_logs',
    "student_id=? AND sent_at LIKE ? AND IFNULL(channel,'inbox')='inbox'",
    [studentId, key]
  );
}

/** 学生是否关闭了主动触达（存于 audit_logs 之外的轻量位置：learner_profiles.activity_pattern） */
function isMuted(studentId) {
  const p = db.get('SELECT activity_pattern FROM learner_profiles WHERE student_id=?', [studentId]);
  if (!p) return false;
  try {
    const o = JSON.parse(p.activity_pattern || '{}');
    return !!o.muted;
  } catch (_) {
    return false;
  }
}

function setMuted(studentId, muted) {
  const p = db.get('SELECT activity_pattern FROM learner_profiles WHERE student_id=?', [studentId]);
  let o = {};
  try {
    o = JSON.parse(p && p.activity_pattern ? p.activity_pattern : '{}');
  } catch (_) {
    o = {};
  }
  o.muted = !!muted;
  db.run(
    `INSERT INTO learner_profiles (student_id, activity_pattern, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(student_id) DO UPDATE SET activity_pattern=excluded.activity_pattern, updated_at=excluded.updated_at`,
    [studentId, JSON.stringify(o), now()]
  );
  return { studentId, muted: !!muted };
}

/** 已推送的今日消息（学生端收件箱）——文案取自当前生效规则配置 */
function push(studentId, ruleId, textOverride) {
  if (isMuted(studentId)) return { sent: false, reason: 'muted' };
  if (inQuietHours()) return { sent: false, reason: 'quiet_hours' };
  if (todayCount(studentId) >= DAILY_CAP) return { sent: false, reason: 'daily_cap' };
  const rule = ruleOf(ruleId);
  if (rule && !rule.enabled) return { sent: false, reason: 'rule_disabled' };
  const text = textOverride || (rule ? rule.text : '');
  db.insert('outreach_logs', { id: uid('ol'), student_id: studentId, rule_id: ruleId, channel: 'inbox', text_sent: text || null, sent_at: now() });
  return { sent: true, text, ruleId, channel: 'inbox' };
}

/**
 * 教师人工直发（FR-507 一键干预）
 * 每日 ≤2 次、静默时段约束的是「系统自动触达」（FR-402），防止机器过度打扰；
 * 教师明确下发的指令属于人工干预，不应被机器配额吞掉，否则一键干预形同虚设。
 * 仍保留两道边界：学生本人关闭触达（muted）优先；channel='teacher' 单独留痕可统计。
 */
function pushDirect(studentId, text, ruleId = 'teacher_intervene') {
  if (isMuted(studentId)) return { sent: false, reason: 'muted' };
  db.insert('outreach_logs', { id: uid('ol'), student_id: studentId, rule_id: ruleId, channel: 'teacher', text_sent: text || null, sent_at: now() });
  return { sent: true, text, ruleId, channel: 'teacher' };
}

// ---------------- 教师端预警（FR-503）----------------

function createAlert({ targetType, targetId, ruleId, reason, suggest }) {
  // 合并：同类（同 target + 同 rule）24 小时内不重复
  const dup = db.get(
    `SELECT * FROM alerts WHERE target_type=? AND target_id=? AND rule_id=? AND status='pending'
     AND created_at >= datetime('now','-24 hours')`,
    [targetType, targetId, ruleId]
  );
  if (dup) return { merged: true, alertId: dup.alert_id };
  const id = uid('al');
  db.insert('alerts', {
    alert_id: id,
    target_type: targetType,
    target_id: targetId,
    rule_id: ruleId,
    trigger_reason: reason,
    suggest: suggest || null,
    status: 'pending',
    created_at: now(),
  });
  return { merged: false, alertId: id };
}

/**
 * 扫描并生成预警（可由定时任务或教师端手动触发）
 * 默认规则：连续 3 天无提交、同一卡点 ≥3 次、封顶解锁申请待处理、Sprint 剩余 48 小时未提交产出物
 */
function scan(classId) {
  const created = [];
  const students = db.all(
    'SELECT * FROM students WHERE status=? ' + (classId ? 'AND class_id=?' : ''),
    classId ? ['active', classId] : ['active']
  );

  // 阈值全部来自 alert_rules 当前配置（教师端可改，立即生效）
  const rNoCommit = ruleOf('no_commit_3d');
  const rSamePoint = ruleOf('same_point_3');
  const rSilent = ruleOf('silent_5d');
  const noCommitHours = ((rNoCommit && rNoCommit.threshold) || 3) * 24;
  const samePointTimes = Math.max(1, (rSamePoint && rSamePoint.threshold) || 3);
  const silentDays = Math.max(1, (rSilent && rSilent.threshold) || 5);

  for (const s of students) {
    // ① 连续多天无会话/无产出（M2：若小组 Git 有更近的提交，以最近活动为准——
    //    学生在仓库里活跃就不算「无提交」，避免误报打扰）
    const lastSession = db.get(
      'SELECT last_at FROM sessions WHERE student_id=? ORDER BY last_at DESC LIMIT 1',
      [s.student_id]
    );
    const lastGit = s.group_id
      ? db.get('SELECT MAX(committed_at) AS t FROM git_commits WHERE group_id=?', [s.group_id])
      : null;
    const lastActivity = Math.max(
      lastSession ? new Date(lastSession.last_at).getTime() : 0,
      lastGit && lastGit.t ? new Date(lastGit.t).getTime() : 0
    );
    const idleH = lastActivity ? (Date.now() - lastActivity) / 3600000 : Infinity;
    if (rNoCommit && rNoCommit.enabled && idleH > noCommitHours) {
      const r = createAlert({
        targetType: 'student',
        targetId: s.student_id,
        ruleId: 'no_commit_3d',
        reason: lastActivity
          ? `连续 ${Math.floor(idleH / 24)} 天无交互（会话与 Git 提交均无动态）`
          : '从未发起会话',
        suggest: '发送一次轻量确认消息，或指派助教跟进',
      });
      if (!r.merged) created.push(r.alertId);
    }

    // ② 同一卡点重复求助（近 7 天，同阶段同知识点，阈值可配）
    const rows = db.all(
      `SELECT stage, knowledge_tags, COUNT(*) AS c FROM help_events
       WHERE student_id=? AND opened_at >= datetime('now','-7 days')
       GROUP BY stage, knowledge_tags HAVING c >= ?`,
      [s.student_id, samePointTimes]
    );
    for (const r of rows) {
      const res = createAlert({
        targetType: 'student',
        targetId: s.student_id,
        ruleId: 'same_point_3',
        reason: `同一卡点重复求助 ${r.c} 次（${r.stage}）`,
        suggest: '建议换角度引导，或安排一次人工辅导',
      });
      if (!res.merged) created.push(res.alertId);
    }

    // ③ 长期沉默（FR-402 silent_5d，天数阈值可配；与 no_commit 的区别是
    //    完全没有任何会话记录的学生也算，触发的是「唤醒」而非「无提交」）
    if (rSilent && rSilent.enabled && idleH > silentDays * 24) {
      const r = createAlert({
        targetType: 'student',
        targetId: s.student_id,
        ruleId: 'silent_5d',
        reason: lastActivity
          ? `已沉默 ${Math.floor(idleH / 24)} 天（无会话、无提交动态）`
          : '注册后从未登录使用',
        suggest: '推送唤醒消息（每周最多 2 次），或了解是否已弃课',
      });
      if (!r.merged) created.push(r.alertId);
    }
  }

  // ④ 封顶解锁申请待处理
  const pendings = db.all("SELECT * FROM unlock_requests WHERE decision='pending'");
  for (const p of pendings) {
    const res = createAlert({
      targetType: 'student',
      targetId: p.student_id,
      ruleId: 'unlock_pending',
      reason: `申请解锁至 L${p.target_level}，待审批`,
      suggest: '在教师端「解锁审批」中处理',
    });
    if (!res.merged) created.push(res.alertId);
  }

  // ⑤ 临近交付节点未完成（deadline_48h：小组 sprint_end 距今不足阈值小时，
  //    且近 48 小时既无产出物入库也无提交）
  const rDeadline = ruleOf('deadline_48h');
  if (rDeadline && rDeadline.enabled) {
    const groups = db.all(
      "SELECT * FROM groups WHERE sprint_end IS NOT NULL AND sprint_end != ''" +
        (classId ? ' AND class_id=?' : ''),
      classId ? [classId] : []
    );
    const deadlineH = (rDeadline.threshold || 48) * 3600000;
    for (const g of groups) {
      const end = new Date(g.sprint_end).getTime();
      if (!Number.isFinite(end) || end < Date.now() || end - Date.now() > deadlineH) continue;
      const recentArt = db.count(
        'artifacts',
        "group_id=? AND created_at >= datetime('now','-48 hours')",
        [g.group_id]
      );
      const recentGit = db.count(
        'git_commits',
        "group_id=? AND committed_at >= datetime('now','-48 hours')",
        [g.group_id]
      );
      if (recentArt === 0 && recentGit === 0) {
        const res = createAlert({
          targetType: 'group',
          targetId: g.group_id,
          ruleId: 'deadline_48h',
          reason: `Sprint ${g.sprint_no} 交付节点距今不足 ${Math.ceil((end - Date.now()) / 3600000)} 小时，近 48 小时无产出物入库、无代码提交`,
          suggest: '推送「当前卡在哪一步」引导消息，或课堂关注该组',
        });
        if (!res.merged) created.push(res.alertId);
      }
    }
  }

  return { created: created.length, alertIds: created };
}

function listAlerts({ status, classId } = {}) {
  const w = [];
  const p = [];
  if (status) {
    w.push('a.status=?');
    p.push(status);
  }
  if (classId) {
    w.push('a.target_id IN (SELECT student_id FROM students WHERE class_id=?)');
    p.push(classId);
  }
  const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
  return db.all(
    `SELECT a.*, s.name AS student_name, s.group_id
     FROM alerts a LEFT JOIN students s ON s.student_id = a.target_id
     ${where} ORDER BY a.created_at DESC LIMIT 200`,
    p
  );
}

function handleAlert(alertId, { status, handlerId, note }) {
  db.update('alerts', 'alert_id', alertId, {
    status: status || 'handled',
    handler_id: handlerId || null,
    handled_at: now(),
  });
  if (note) {
    db.run('UPDATE alerts SET trigger_reason = trigger_reason || ? WHERE alert_id=?', [' | 处理备注：' + note, alertId]);
  }
  return db.get('SELECT * FROM alerts WHERE alert_id=?', [alertId]);
}

module.exports = {
  DEFAULT_RULES, scan, createAlert, listAlerts, handleAlert, push, pushDirect,
  inQuietHours, isMuted, setMuted, todayCount, QUIET_HOURS, DAILY_CAP,
  ensureRuleDefaults, listRules, ruleOf, updateRule,
};
