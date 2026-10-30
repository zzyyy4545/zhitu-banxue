'use strict';
/**
 * 教师端接口（FR-501 ~ FR-508）
 * GET  /api/v1/teacher/dashboard              班级总览看板
 * GET  /api/v1/teacher/knowledge-heatmap      知识点热力
 * GET  /api/v1/teacher/alerts                 预警列表
 * POST /api/v1/teacher/alerts/{id}/handle     处理预警
 * GET  /api/v1/teacher/clusters               求助聚类与课堂反哺
 * PUT  /api/v1/teacher/policies               封顶层与策略配置
 * GET  /api/v1/teacher/unlock-requests        解锁申请
 * POST /api/v1/unlock-requests/{id}/decision  审批
 * POST /api/v1/teacher/intervene              一键干预与群发
 * GET  /api/v1/teacher/obe-export             OBE 证据导出
 */
const db = require('../db');
const auth = require('../middleware/auth');
const stages = require('../core/stages');
const policy = require('../core/policy');
const metrics = require('../core/metrics');
const alerts = require('../core/alerts');
const knowledge = require('../core/knowledge');
const { now, jparse, uid, clampLevel } = require('../core/util');

module.exports = function (app) {
  // FR-501 班级总览看板
  app.get('/api/v1/teacher/dashboard', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const scope = auth.classScopeOf(req.user);
    const classId = req.query.classId || (scope ? scope[0] : null);
    const where = classId ? 'WHERE g.class_id=?' : '';
    const groupRows = db.all(
      `SELECT g.*, (SELECT COUNT(*) FROM students s WHERE s.group_id=g.group_id) AS member_count
       FROM groups g ${where} ORDER BY g.group_id LIMIT 200`,
      classId ? [classId] : []
    );

    const groups = groupRows.map((g) => {
      const evs = db.all('SELECT * FROM help_events WHERE group_id=?', [g.group_id]);
      const openStuck = evs.filter((e) => e.status === 'open').length;
      const arts = db.count('artifacts', 'group_id=?', [g.group_id]);
      const totalNodes = (stages.get(g.current_stage) || { nodes: [] }).nodes.length;
      const progress = Math.min(100, Math.round((arts / Math.max(1, totalNodes)) * 100));
      const risky = openStuck >= 2 || progress < 30;
      return {
        groupId: g.group_id, name: g.project_name, stage: g.current_stage,
        stageName: (stages.get(g.current_stage) || {}).name,
        sprintNo: g.sprint_no, members: g.member_count, progress,
        openStuck, risk: risky ? (openStuck >= 2 ? 'stuck' : 'behind') : null,
      };
    });

    const studentWhere = classId ? 'WHERE class_id=?' : '';
    const activeStudents = db.count(
      'sessions',
      classId
        ? `last_at >= datetime('now','-7 days') AND student_id IN (SELECT student_id FROM students ${studentWhere})`
        : `last_at >= datetime('now','-7 days')`,
      classId ? [classId] : []
    );
    const todayHelps = db.count(
      'help_events',
      classId
        ? `opened_at >= date('now') AND student_id IN (SELECT student_id FROM students ${studentWhere})`
        : `opened_at >= date('now')`,
      classId ? [classId] : []
    );
    const pendingAlerts = db.count('alerts', "status='pending'");
    const turns = metrics.avgTurns({ classId });
    const dist = metrics.levelDistribution({ classId });
    const rate = metrics.resolveRate({ classId });
    const guard = metrics.guardrailStats({ classId });

    res.json({
      cards: {
        activeStudents,
        todayHelps,
        pendingAlerts,
        avgTurns: turns.avgTurns,
        resolveRate: rate.rate,
        lowLevelShare: dist.lowShare,
        guardBlocks: guard.total,
      },
      groups,
      levelDistribution: dist,
      generatedAt: now(),
    });
  });

  // FR-502 学情画像与知识点热力
  app.get('/api/v1/teacher/knowledge-heatmap', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const classId = req.query.classId || null;
    const stage = req.query.stage || null;
    const heat = metrics.knowledgeHeat({ classId }).filter((h) => !stage || h.stages.includes(stage));
    const uncovered = metrics.uncoveredKnowledge({ classId });
    res.json({ heat, uncovered, total: heat.length });
  });

  // 学生/小组下钻
  app.get('/api/v1/teacher/students', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const classId = req.query.classId || null;
    const groupId = req.query.groupId || null;
    const w = [];
    const p = [];
    if (classId) { w.push('class_id=?'); p.push(classId); }
    if (groupId) { w.push('group_id=?'); p.push(groupId); }
    const rows = db.all(
      `SELECT * FROM students ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY student_id LIMIT 500`, p
    );
    res.json({
      students: rows.map((s) => {
        const prof = db.get('SELECT * FROM learner_profiles WHERE student_id=?', [s.student_id]);
        const evs = db.all('SELECT * FROM help_events WHERE student_id=?', [s.student_id]);
        return {
          studentId: s.student_id, name: s.name, groupId: s.group_id, role: s.role,
          baseLevel: prof ? prof.base_level : '初学',
          avgTurns: prof ? prof.avg_turns : 0,
          events: evs.length,
          openStuck: evs.filter((e) => e.status === 'open').length,
          stuckTags: prof ? jparse(prof.stuck_tags, []).slice(0, 5) : [],
        };
      }),
    });
  });

  // 单个学生的过程证据（FR-604 学术诚信护栏：可解释 + 证据包）
  app.get('/api/v1/teacher/students/:id/evidence', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const sid = req.params.id;
    const evs = db.all('SELECT * FROM help_events WHERE student_id=? ORDER BY opened_at DESC LIMIT 50', [sid]);
    const arts = db.all('SELECT * FROM artifacts WHERE student_id=? ORDER BY created_at DESC LIMIT 50', [sid]);
    const guards = db.all('SELECT * FROM guardrail_logs WHERE student_id=? ORDER BY created_at DESC LIMIT 30', [sid]);
    const prof = db.get('SELECT * FROM learner_profiles WHERE student_id=?', [sid]);
    const student = db.get('SELECT * FROM students WHERE student_id=?', [sid]);

    // 异常检测（可解释，不判定作弊）
    const anomalies = [];
    const maxLevelEvents = evs.filter((e) => (e.max_level || 0) >= 3);
    if (maxLevelEvents.length >= 3) {
      anomalies.push({ code: 'A_HIGH_LEVEL', detail: `多次求助达到 L3–L4（${maxLevelEvents.length} 次）`, evidence: maxLevelEvents.slice(0, 5).map((e) => e.title) });
    }
    const noProcess = arts.filter((a) => (a.version || 1) === 1).length;
    if (arts.length && noProcess === arts.length && evs.length <= 1) {
      anomalies.push({ code: 'A_NO_PROCESS', detail: '产出物均为首版且几乎无求助记录，缺少演化轨迹', evidence: arts.slice(0, 3).map((a) => a.stage) });
    }
    const blocks = guards.filter((g) => g.result !== 'pass').length;
    if (blocks >= 2) {
      anomalies.push({ code: 'A_GUARD_BLOCK', detail: `护栏拦截 ${blocks} 次`, evidence: guards.filter((g) => g.result !== 'pass').slice(0, 5).map((g) => g.reason_code) });
    }

    res.json({
      student,
      profile: prof ? { ...prof, progress: jparse(prof.progress, {}), stuck_tags: jparse(prof.stuck_tags, []), level_distribution: jparse(prof.level_distribution, {}) } : null,
      events: evs, artifacts: arts.map((a) => ({ ...a, content: jparse(a.content, {}) })),
      guardrail: guards,
      anomalies,
      note: '本包仅做过程留痕：标记仅提示教师，系统不判定、不下作弊结论（FR-604 红线）',
    });
  });

  // FR-503 预警
  app.get('/api/v1/teacher/alerts', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const status = req.query.status || null;
    const scope = auth.classScopeOf(req.user);
    const list = alerts.listAlerts({ status, classId: scope ? scope[0] : null });
    res.json({ alerts: list, rules: alerts.listRules() });
  });

  // FR-503/402 规则配置：阈值 / 文案 / 启停，落库即时生效
  app.get('/api/v1/teacher/alert-rules', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    res.json({ rules: alerts.listRules(), quietHours: alerts.QUIET_HOURS, dailyCap: alerts.DAILY_CAP });
  });

  app.put('/api/v1/teacher/alert-rules/:id', auth.requireRole('teacher', 'admin'), (req, res) => {
    const { threshold, text, enabled } = req.body || {};
    const r = alerts.updateRule(req.params.id, { threshold, text, enabled });
    auth.audit(req.user.user_id, req.user.role, 'update_alert_rule', req.params.id, { threshold, text, enabled });
    res.json({ ok: true, rule: r });
  });

  app.post('/api/v1/teacher/alerts/:id/handle', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const { status, note } = req.body || {};
    const r = alerts.handleAlert(req.params.id, { status: status || 'handled', handlerId: req.user.ref_id, note });
    auth.audit(req.user.user_id, req.user.role, 'handle_alert', req.params.id, { status, note });
    res.json(r);
  });

  app.post('/api/v1/teacher/alerts/scan', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const scope = auth.classScopeOf(req.user);
    const r = alerts.scan(scope ? scope[0] : null);
    auth.audit(req.user.user_id, req.user.role, 'scan_alerts', null, r);
    res.json(r);
  });

  // FR-504 求助聚类与课堂反哺
  app.get('/api/v1/teacher/clusters', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const classId = req.query.classId || null;
    const rows = db.all(
      `SELECT e.stage, e.node_id, e.title, e.knowledge_tags, COUNT(*) AS c, AVG(e.turn_count) AS t
       FROM help_events e
       ${classId ? 'WHERE e.student_id IN (SELECT student_id FROM students WHERE class_id=?)' : ''}
       GROUP BY e.stage, e.node_id ORDER BY c DESC LIMIT 20`,
      classId ? [classId] : []
    );
    const clusters = rows.map((r) => ({
      stage: r.stage,
      stageName: (stages.get(r.stage) || {}).name,
      nodeId: r.node_id,
      title: r.title,
      count: r.c,
      avgTurns: +(r.t || 0).toFixed(2),
      tags: jparse(r.knowledge_tags, []),
      sampleQuestions: sampleQuestions(r.stage, r.node_id),
    }));
    res.json({ clusters, topN: clusters.slice(0, 5) });
  });

  // 课堂补充材料提纲（仅提纲，不生成完整讲义）
  app.post('/api/v1/teacher/outline', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const { clusterKeys } = req.body || {};
    const keys = Array.isArray(clusterKeys) ? clusterKeys : [];
    const outline = keys.map((k) => {
      const [stage, nodeId] = String(k).split('|');
      const cfg = stages.get(stage);
      const node = cfg ? cfg.nodes.find((n) => n.id === nodeId) : null;
      return {
        stage, nodeId,
        title: node ? node.title : (cfg ? cfg.name : k),
        goal: node ? node.goal : '',
        points: [
          '学生在该环节的典型表现（引用代表性问法）',
          '根因：概念误解还是方法缺失',
          '课堂讲解要点（不超过三条）',
          '随堂练习：一道同类题，课堂当场做',
        ],
        knowledgeTags: cfg ? cfg.knowledgeTags : [],
      };
    });
    auth.audit(req.user.user_id, req.user.role, 'generate_outline', null, { clusterKeys: keys });
    res.json({ outline, note: '仅提纲，不含讲义正文（FR-504 验收标准）' });
  });

  // FR-505 封顶层与策略配置
  app.get('/api/v1/teacher/policies', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    res.json({ policies: policy.listPolicies(), defaults: policy.DEFAULT_CAPS, stages: stages.all().map((s) => ({ key: s.key, name: s.name })) });
  });

  app.put('/api/v1/teacher/policies', auth.requireRole('teacher', 'admin'), (req, res) => {
    const { scope, scopeId, stage, capLevel, activeFrom, activeTo, note } = req.body || {};
    if (!scope) throw Object.assign(new Error('缺少 scope'), { status: 400 });
    const r = policy.setPolicy({
      scope, scopeId, stage, capLevel, activeFrom, activeTo,
      updatedBy: req.user.ref_id || req.user.user_id, note,
    });
    auth.audit(req.user.user_id, req.user.role, 'set_policy', r.policyId, { scope, scopeId, stage, capLevel, activeFrom, activeTo });
    res.json(r);
  });

  app.delete('/api/v1/teacher/policies/:id', auth.requireRole('teacher', 'admin'), (req, res) => {
    policy.deletePolicy(req.params.id);
    auth.audit(req.user.user_id, req.user.role, 'delete_policy', req.params.id, {});
    res.json({ ok: true });
  });

  // FR-506 解锁审批
  app.get('/api/v1/teacher/unlock-requests', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const rows = db.all(
      `SELECT r.*, s.name AS student_name, s.group_id
       FROM unlock_requests r LEFT JOIN students s ON s.student_id=r.student_id
       ORDER BY r.created_at DESC LIMIT 50`
    );
    res.json({
      requests: rows.map((r) => ({ ...r, trace: jparse(r.trace, {}) })),
    });
  });

  app.post('/api/v1/unlock-requests/:id/decision', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const { decision, note, validHours } = req.body || {};
    if (!['approved', 'rejected', 'human'].includes(decision)) {
      throw Object.assign(new Error('decision 只能取 approved / rejected / human'), { status: 400 });
    }
    const r = db.get('SELECT * FROM unlock_requests WHERE req_id=?', [req.params.id]);
    if (!r) throw Object.assign(new Error('申请不存在'), { status: 404 });
    const validUntil =
      decision === 'approved'
        ? new Date(Date.now() + (validHours || 24) * 3600 * 1000).toISOString()
        : null;
    db.update('unlock_requests', 'req_id', req.params.id, {
      decision,
      decided_note: note || null,
      approver_id: req.user.ref_id || req.user.user_id,
      valid_until: validUntil,
      decided_at: now(),
    });
    auth.audit(req.user.user_id, req.user.role, 'unlock_decision', req.params.id, { decision, note, validHours });

    // 通知学生（站内系统消息）
    const sessions = db.all(
      'SELECT * FROM sessions WHERE student_id=? ORDER BY last_at DESC LIMIT 1',
      [r.student_id]
    );
    if (sessions[0]) {
      const map = {
        approved: `教师已批准解锁至 L${r.target_level}，有效期至 ${String(validUntil).slice(0, 16)}。到期后自动回落至原封顶层。`,
        rejected: `教师驳回了本次解锁申请${note ? '：' + note : ''}。我们换个思路，把这一步再拆小一点。`,
        human: `教师已指派人工辅导${note ? '：' + note : ''}。这一步由老师或助教直接带你过。`,
      };
      db.insert('messages', {
        msg_id: uid('msg'), session_id: sessions[0].session_id, role: 'system',
        content: map[decision], level: null, created_at: now(),
      });
    }
    res.json({ ok: true, decision, validUntil });
  });

  // FR-507 一键干预与群发
  app.post('/api/v1/teacher/intervene', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const { audience, text, ruleId, tag, confirm } = req.body || {};
    if (!confirm) throw Object.assign(new Error('发送前需二次确认（confirm=true）'), { status: 400 });
    if (!text) throw Object.assign(new Error('缺少消息内容'), { status: 400 });

    let ids = [];
    if (audience === 'all') {
      ids = db.all('SELECT student_id FROM students').map((x) => x.student_id);
    } else if (audience === 'alert' && ruleId) {
      ids = db.all('SELECT DISTINCT target_id FROM alerts WHERE rule_id=? AND status=?', [ruleId, 'pending'])
        .map((x) => x.target_id);
    } else if (audience === 'tag' && tag) {
      ids = db.all(
        `SELECT DISTINCT student_id FROM help_events WHERE knowledge_tags LIKE ?`,
        ['%' + tag + '%']
      ).map((x) => x.student_id);
    } else if (Array.isArray(audience)) {
      ids = audience;
    }

    let sent = 0;
    const failed = [];
    for (const sid of ids.slice(0, 500)) {
      const r = pushTo(sid, text);
      if (r.sent) sent++;
      else failed.push({ studentId: sid, reason: r.reason });
    }
    auth.audit(req.user.user_id, req.user.role, 'intervene', null, { audience, ruleId, tag, sent, failed: failed.length });
    res.json({ sent, failed: failed.length, failedReasons: failed.slice(0, 10), total: ids.length });
  });

  // FR-508 OBE 证据导出
  app.get('/api/v1/teacher/obe-export', auth.requireRole('teacher', 'admin'), (req, res) => {
    const anonymize = req.query.anonymize !== '0';
    const r = metrics.obeExport({
      classId: req.query.classId || null,
      groupId: req.query.groupId || null,
      from: req.query.from || null,
      to: req.query.to || null,
      anonymize,
    });
    auth.audit(req.user.user_id, req.user.role, 'obe_export', null, { anonymize });
    if (req.query.format === 'csv') {
      // Excel 未启用 UTF-8 编码检测时按本地 GBK 解码 CSV，中文会乱码。
      // 必须在文件头写入 UTF-8 BOM，否则评委下载打开看到的是错字。
      return res.download('OBE_evidence.csv', Buffer.from('\uFEFF' + r.csv, 'utf8'), 'text/csv; charset=utf-8');
    }
    if (req.query.format === 'md') {
      return res.download('OBE_evidence.md', Buffer.from(r.md, 'utf8'), 'text/markdown; charset=utf-8');
    }
    res.json(r);
  });

  // 教师答疑工时登记
  app.post('/api/v1/teacher/worklog', auth.requireRole('teacher', 'ta'), (req, res) => {
    const { minutes, category, note } = req.body || {};
    db.insert('teacher_worklog', {
      id: uid('wl'), teacher_id: req.user.ref_id, minutes: minutes || 0,
      category: category || 'manual', source: 'self', note: note || null, created_at: now(),
    });
    res.json({ ok: true, workload: metrics.teacherWorkload({ teacherId: req.user.ref_id }) });
  });

  // 越界尝试统计（教师端）
  app.get('/api/v1/teacher/guardrail-stats', auth.requireRole('teacher', 'admin'), (req, res) => {
    res.json(metrics.guardrailStats({ from: req.query.from || null }));
  });

  // 知识点修正（FR-502 标签可人工修正并留痕）
  app.post('/api/v1/teacher/events/:id/retag', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const { tags } = req.body || {};
    const ev = db.get('SELECT * FROM help_events WHERE event_id=?', [req.params.id]);
    if (!ev) throw Object.assign(new Error('事件不存在'), { status: 404 });
    db.update('help_events', 'event_id', req.params.id, { knowledge_tags: JSON.stringify(tags || []) });
    auth.audit(req.user.user_id, req.user.role, 'retag_event', req.params.id, { from: jparse(ev.knowledge_tags, []), to: tags });
    res.json({ ok: true });
  });

  // 知识点检索（教师维护图谱用）
  app.get('/api/v1/teacher/knowledge', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const q = req.query.q;
    res.json({
      nodes: q ? knowledge.search(q, 10) : db.all('SELECT * FROM knowledge_nodes ORDER BY node_id'),
    });
  });

  // ==================== FR-601 知识图谱维护（增改删 + 留痕） ====================

  app.post('/api/v1/teacher/knowledge', auth.requireRole('teacher', 'admin'), (req, res) => {
    const { nodeId, name, parentId, level, definition, misconceptions, resources, targetIds, keywords } = req.body || {};
    if (!name) throw Object.assign(new Error('缺少知识点名称'), { status: 400 });
    const id = nodeId || ('KN-' + require('../core/util').uid('n').split('_')[1]);
    const exist = db.get('SELECT node_id FROM knowledge_nodes WHERE node_id=?', [id]);
    db.run(
      `INSERT INTO knowledge_nodes (node_id, name, parent_id, level, definition, misconceptions, resources, target_ids, keywords, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(node_id) DO UPDATE SET
         name=excluded.name, parent_id=excluded.parent_id, level=excluded.level,
         definition=excluded.definition, misconceptions=excluded.misconceptions,
         resources=excluded.resources, target_ids=excluded.target_ids,
         keywords=excluded.keywords, updated_at=excluded.updated_at`,
      [
        id, name, parentId || null, Number(level) || (parentId ? 2 : 1),
        definition || null,
        JSON.stringify(Array.isArray(misconceptions) ? misconceptions : []),
        JSON.stringify(Array.isArray(resources) ? resources : []),
        JSON.stringify(Array.isArray(targetIds) ? targetIds : []),
        JSON.stringify(Array.isArray(keywords) ? keywords : []),
        now(),
      ]
    );
    auth.audit(req.user.user_id, req.user.role, exist ? 'update_knowledge_node' : 'add_knowledge_node', id, { name, parentId });
    res.json({ ok: true, nodeId: id, updated: !!exist });
  });

  app.delete('/api/v1/teacher/knowledge/:id', auth.requireRole('teacher', 'admin'), (req, res) => {
    const n = db.get('SELECT * FROM knowledge_nodes WHERE node_id=?', [req.params.id]);
    if (!n) throw Object.assign(new Error('知识点不存在'), { status: 404 });
    // 有子节点或已被求助记录引用时不允许物理删除（保证图谱与留痕完整性）
    const children = db.count('knowledge_nodes', 'parent_id=?', [req.params.id]);
    const referenced = db.count('help_events', "knowledge_tags LIKE ?", ['%"' + n.name + '"%']);
    if (children || referenced) {
      throw Object.assign(
        new Error(`该节点有 ${children} 个子节点 / ${referenced} 条求助记录引用，不能删除；可改名或调整定义`),
        { status: 400 }
      );
    }
    db.run('DELETE FROM knowledge_nodes WHERE node_id=?', [req.params.id]);
    auth.audit(req.user.user_id, req.user.role, 'delete_knowledge_node', req.params.id, { name: n.name });
    res.json({ ok: true });
  });

  // ==================== FR-401 学习节拍器：教师观察 ====================
  app.get('/api/v1/teacher/goals', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const metronome = require('../core/metronome');
    res.json(metronome.groupToday(req.query.groupId || null, req.query.classId || null));
  });
};

function sampleQuestions(stage, nodeId) {
  const rows = db.all(
    `SELECT m.content FROM messages m
     JOIN help_events e ON e.session_id = m.session_id
     WHERE e.stage=? AND e.node_id=? AND m.role='student'
     ORDER BY m.created_at DESC LIMIT 3`,
    [stage, nodeId]
  );
  return rows.map((r) => String(r.content).slice(0, 60));
}

function pushTo(studentId, text) {
  return alerts.pushDirect(studentId, text);
}

void clampLevel;
