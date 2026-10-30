'use strict';
/**
 * 学生端接口（6.1）
 * POST /api/v1/sessions                     创建会话
 * POST /api/v1/sessions/{id}/messages       发送消息
 * POST /api/v1/sessions/{id}/upgrade        请求层级升级（受封顶约束）
 * GET  /api/v1/sessions/{id}/export         导出会话 Markdown（FR-109）
 * POST /api/v1/artifacts                    提交阶段产出物
 */
const db = require('../db');
const auth = require('../middleware/auth');
const pipeline = require('../core/pipeline');
const stages = require('../core/stages');
const policy = require('../core/policy');
const profile = require('../core/profile');
const knowledge = require('../core/knowledge');
const alerts = require('../core/alerts');
const metronome = require('../core/metronome');
const attachmentsMod = require('../core/attachments');
const { now, jparse, clampLevel } = require('../core/util');

module.exports = function (app) {
  // 阶段列表（含红线声明，透明原则）
  app.get('/api/v1/stages', auth.requireAuth, (req, res) => {
    res.json({
      stages: stages.all().map((s) => ({
        key: s.key, name: s.name, fr: s.fr, goal: s.goal,
        artifactName: s.artifactName, artifactType: s.artifactType,
        artifactFields: s.artifactFields, redLines: s.redLines,
        knowledgeTags: s.knowledgeTags, invest: s.invest || null,
        nodes: s.nodes.map((n) => ({ id: n.id, title: n.title, goal: n.goal, options: n.options || [] })),
      })),
    });
  });

  // 创建会话（FR-101）
  app.post('/api/v1/sessions', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) {
      const e = new Error('当前账号未绑定学生');
      e.status = 400;
      throw e;
    }
    const { stage, channel } = req.body || {};
    const stg = stage && stages.get(stage) ? stage : 'requirements';
    const { session, resumed } = pipeline.ensureSession(student, { stage: stg, channel });
    const cfg = stages.get(session.stage);
    const cap = policy.resolveCap({
      classId: student.class_id, groupId: student.group_id, stage: session.stage,
    });
    const group = db.get('SELECT * FROM groups WHERE group_id=?', [student.group_id]);

    if (!resumed) {
      const op = require('../core/tutor').opening(cfg, student, group, session.sprint_no);
      pipeline.saveMessage(session.session_id, 'system', `Sprint ${session.sprint_no} · ${cfg.name} · 介入层级 L0 · 封顶 L${cap.cap}`, {});
      pipeline.saveMessage(session.session_id, 'agent', op.text, { level: 0, intent: 'greeting', engine: 'rule' });
    }

    res.json({
      session: {
        sessionId: session.session_id, stage: session.stage, stageName: cfg.name,
        sprintNo: session.sprint_no, nodeId: session.node_id, level: session.level,
        capLevel: cap.cap, capSource: cap.source, title: session.title, resumed,
        draft: draftOf(session.session_id),
      },
      messages: messagesOf(session.session_id),
      context: {
        stage: session.stage,
        stageName: cfg.name,
        nodeTitle: (stages.nodeOf(session.stage, session.node_id) || {}).title,
        progress: stages.progressOf(session.stage, session.node_id),
        capLevel: cap.cap,
        group: group ? { id: group.group_id, name: group.project_name, sprintNo: group.sprint_no } : null,
      },
    });
  });

  // 会话详情
  app.get('/api/v1/sessions/:id', auth.requireAuth, (req, res) => {
    const s = db.get('SELECT * FROM sessions WHERE session_id=?', [req.params.id]);
    if (!s) throw Object.assign(new Error('会话不存在'), { status: 404 });
    auth.assertStudentVisible(req.user, s.student_id);
    const cfg = stages.get(s.stage);
    const cap = policy.resolveCap({ classId: null, groupId: null, stage: s.stage });
    res.json({
      session: s,
      draft: draftOf(s.session_id),
      stageName: cfg ? cfg.name : '',
      capLevel: cap.cap,
      messages: messagesOf(s.session_id),
      progress: stages.progressOf(s.stage, s.node_id),
    });
  });

  // 我的会话列表
  app.get('/api/v1/sessions', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) return res.json({ sessions: [] });
    const rows = db.all(
      'SELECT * FROM sessions WHERE student_id=? ORDER BY last_at DESC LIMIT 20',
      [student.student_id]
    );
    res.json({
      sessions: rows.map((s) => ({
        sessionId: s.session_id, stage: s.stage, title: s.title,
        level: s.level, startedAt: s.started_at, lastAt: s.last_at,
        stageName: (stages.get(s.stage) || {}).name,
      })),
    });
  });

  // 发送消息（4.2 完整时序）
  app.post('/api/v1/sessions/:id/messages', auth.requireAuth, async (req, res) => {
    const s = db.get('SELECT * FROM sessions WHERE session_id=?', [req.params.id]);
    if (!s) throw Object.assign(new Error('会话不存在'), { status: 404 });
    auth.assertStudentVisible(req.user, s.student_id);
    const student = db.get('SELECT * FROM students WHERE student_id=?', [s.student_id]);
    const { text, attachments } = req.body || {};

    // FR-105 多模态：文本/代码附件结构化解析 + 复述确认；图片低置信度反问，不臆测
    let attachNote = '';
    let attachQuestion = null;
    if (Array.isArray(attachments) && attachments.length) {
      const r = attachmentsMod.handleAttachments({
        studentId: s.student_id,
        sessionId: s.session_id,
        attachments,
      });
      attachNote = r.note;
      attachQuestion = r.question;
    }

    const out = await pipeline.handleMessage({
      student,
      sessionId: s.session_id,
      text: (text || '') + attachNote,
      attachments: attachments || [],
      channel: s.channel,
    });

    // 低置信度附件的反问置顶展示（FR-105：不产生臆断结论）
    if (attachQuestion && out.reply && typeof out.reply.text === 'string') {
      out.reply = { ...out.reply, text: attachQuestion + '\n\n' + out.reply.text };
    }

    res.json({
      reply: out.reply,
      context: out.context,
      source: out.context.source,
      session: {
        sessionId: out.session.session_id,
        stage: out.session.stage,
        nodeId: out.session.node_id,
        level: out.session.level,
        draft: draftOf(s.session_id),
      },
      messages: messagesOf(s.session_id),
    });
  });

  // 会话附件留痕（FR-105：解析结果可回传教师端 / 学生自查）
  app.get('/api/v1/sessions/:id/attachments', auth.requireAuth, (req, res) => {
    const s = db.get('SELECT * FROM sessions WHERE session_id=?', [req.params.id]);
    if (!s) throw Object.assign(new Error('会话不存在'), { status: 404 });
    auth.assertStudentVisible(req.user, s.student_id);
    res.json({ attachments: attachmentsMod.listOfSession(s.session_id) });
  });

  // 层级升级（FR-102）
  app.post('/api/v1/sessions/:id/upgrade', auth.requireAuth, async (req, res) => {
    const s = db.get('SELECT * FROM sessions WHERE session_id=?', [req.params.id]);
    if (!s) throw Object.assign(new Error('会话不存在'), { status: 404 });
    auth.assertStudentVisible(req.user, s.student_id);
    const student = db.get('SELECT * FROM students WHERE student_id=?', [s.student_id]);
    const out = await pipeline.handleUpgrade({ student, sessionId: s.session_id });
    res.json({ ...out, messages: messagesOf(s.session_id) });
  });

  // 导出会话 Markdown（FR-109）
  app.get('/api/v1/sessions/:id/export', auth.requireAuth, (req, res) => {
    const s = db.get('SELECT * FROM sessions WHERE session_id=?', [req.params.id]);
    if (!s) throw Object.assign(new Error('会话不存在'), { status: 404 });
    auth.assertStudentVisible(req.user, s.student_id);

    const msgs = db.all('SELECT * FROM messages WHERE session_id=? ORDER BY created_at', [s.session_id]);
    const evs = db.all('SELECT * FROM help_events WHERE session_id=? ORDER BY opened_at', [s.session_id]);
    const cfg = stages.get(s.stage);
    const student = db.get('SELECT * FROM students WHERE student_id=?', [s.student_id]);
    const tags = [...new Set(evs.flatMap((e) => jparse(e.knowledge_tags, [])))];

    const md =
      `# 导学过程记录 · ${cfg ? cfg.name : s.stage}\n\n` +
      `- 学生：${student ? student.name : ''}（${s.student_id}）\n` +
      `- 阶段：${cfg ? cfg.name : s.stage}　Sprint：${s.sprint_no}\n` +
      `- 会话时间：${s.started_at} → ${s.last_at}\n\n` +
      `## 一、卡点列表\n\n` +
      (evs.length
        ? evs.map((e, i) => `${i + 1}. ${e.title}（${e.status === 'resolved' ? '已解决' : '进行中'}，最高层级 L${e.max_level}，${e.turn_count} 轮）`).join('\n')
        : '（无）') +
      `\n\n## 二、涉及知识点\n\n${tags.length ? tags.map((t) => '- ' + t).join('\n') : '（无）'}\n\n` +
      `## 三、对话留痕\n\n` +
      msgs
        .map((m) => `**${m.role === 'agent' ? '知途' : m.role === 'student' ? '我' : '系统'}**（${m.created_at}）\n\n${m.content}\n`)
        .join('\n---\n\n') +
      `\n\n## 四、过程指标\n\n` +
      `- 求助事件数：${evs.length}\n` +
      `- 已解决：${evs.filter((e) => e.status === 'resolved').length}\n` +
      `- 层级分布：${JSON.stringify(evs.reduce((a, e) => { const k = 'L' + e.max_level; a[k] = (a[k] || 0) + 1; return a; }, {}))}\n`;

    const filename = `导学记录_${cfg ? cfg.name : s.stage}_${String(s.started_at).slice(0, 10)}.md`;
    if (req.query.download === '1') {
      return res.download(filename, Buffer.from(md, 'utf8'), 'text/markdown; charset=utf-8');
    }
    res.json({ filename, markdown: md });
  });

  // 提交产出物（FR-207）
  app.post('/api/v1/artifacts', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) throw Object.assign(new Error('当前账号未绑定学生'), { status: 400 });
    const { stage, type, content } = req.body || {};
    const cfg = stages.get(stage);
    if (!cfg) throw Object.assign(new Error('未知阶段'), { status: 400 });
    const id = pipeline.writeArtifact(student, { session_id: null, stage }, cfg);
    if (content && typeof content === 'object') {
      db.update('artifacts', 'artifact_id', id, { content: JSON.stringify(content) });
    }
    auth.audit(req.user.user_id, req.user.role, 'submit_artifact', id, { stage, type });
    res.json({ artifactId: id });
  });

  // 我的产出物
  app.get('/api/v1/artifacts', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) return res.json({ artifacts: [] });
    const rows = db.all(
      'SELECT * FROM artifacts WHERE group_id=? OR student_id=? ORDER BY created_at DESC LIMIT 50',
      [student.group_id, student.student_id]
    );
    res.json({
      artifacts: rows.map((a) => ({
        ...a, content: jparse(a.content, {}), knowledge_tags: jparse(a.knowledge_tags, []),
        stageName: (stages.get(a.stage) || {}).name,
      })),
    });
  });

  // 我的画像（透明原则）
  app.get('/api/v1/student/profile', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) throw Object.assign(new Error('当前账号未绑定学生'), { status: 400 });
    const p = profile.get(student.student_id);
    res.json({
      profile: {
        baseLevel: p.base_level, preferStyle: p.prefer_style,
        progress: jparse(p.progress, {}), stuckTags: jparse(p.stuck_tags, []),
        levelDistribution: jparse(p.level_distribution, {}), avgTurns: p.avg_turns,
        activity: jparse(p.activity_pattern, {}),
      },
      muted: alerts.isMuted(student.student_id),
    });
  });

  // 画像申诉修正
  app.post('/api/v1/student/profile/appeal', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) throw Object.assign(new Error('当前账号未绑定学生'), { status: 400 });
    const { baseLevel, preferStyle, reason } = req.body || {};
    const r = profile.appeal(student.student_id, { baseLevel, preferStyle }, reason);
    auth.audit(req.user.user_id, req.user.role, 'profile_appeal', student.student_id, { reason, baseLevel, preferStyle });
    res.json(r);
  });

  // 主动触达开关（FR-402 边界：任意触达可在学生端关闭）
  app.post('/api/v1/student/outreach/mute', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) throw Object.assign(new Error('当前账号未绑定学生'), { status: 400 });
    const muted = !!(req.body && req.body.muted);
    const r = alerts.setMuted(student.student_id, muted);
    auth.audit(req.user.user_id, req.user.role, 'outreach_mute', student.student_id, { muted });
    res.json(r);
  });

  // 我的收件箱（主动触达消息）
  app.get('/api/v1/student/inbox', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) return res.json({ items: [] });
    const rows = db.all(
      'SELECT * FROM outreach_logs WHERE student_id=? ORDER BY sent_at DESC LIMIT 20',
      [student.student_id]
    );
    const rules = alerts.listRules();
    res.json({
      items: rows.map((r) => {
        const rule = rules.find((x) => x.id === r.rule_id);
        return { id: r.id, ruleId: r.rule_id, ruleName: rule ? rule.name : r.rule_id, text: r.text_sent || (rule ? rule.text : ''), sentAt: r.sent_at };
      }),
    });
  });

  // 提交解锁申请（FR-506）
  app.post('/api/v1/unlock-requests', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) throw Object.assign(new Error('当前账号未绑定学生'), { status: 400 });
    const { sessionId, targetLevel, reason } = req.body || {};
    const session = sessionId ? db.get('SELECT * FROM sessions WHERE session_id=?', [sessionId]) : null;
    const node = session ? stages.nodeOf(session.stage, session.node_id) : null;
    const id = pipeline.createUnlockRequest({
      student,
      eventId: session ? session.event_id : null,
      targetLevel: clampLevel(targetLevel === undefined ? 4 : targetLevel),
      reason: reason || `在「${node ? node.title : '当前环节'}」卡住，申请更完整的讲解`,
      trace: { levelTrail: [session ? session.level : 0] },
    });
    alerts.createAlert({
      targetType: 'student', targetId: student.student_id, ruleId: 'unlock_pending',
      reason: `申请解锁至 L${clampLevel(targetLevel === undefined ? 4 : targetLevel)}`, suggest: '在教师端「解锁审批」中处理',
    });
    auth.audit(req.user.user_id, req.user.role, 'unlock_request', id, { targetLevel, reason });
    res.json({ reqId: id, status: 'pending' });
  });

  // 我的解锁申请状态
  app.get('/api/v1/unlock-requests', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) return res.json({ requests: [] });
    const rows = db.all(
      'SELECT * FROM unlock_requests WHERE student_id=? ORDER BY created_at DESC LIMIT 10',
      [student.student_id]
    );
    res.json({ requests: rows });
  });

  // 概念精讲（FR-103）独立入口
  app.get('/api/v1/concept', auth.requireAuth, (req, res) => {
    const q = req.query.q || '';
    const student = auth.studentOf(req.user);
    const p = student ? profile.get(student.student_id) : { base_level: '初学' };
    const ex = knowledge.explain(q, p.base_level);
    res.json(ex);
  });

  /* ==================== FR-401 学习节拍器 ==================== */

  // 我的微目标（首次访问自动按阶段剧本拆解生成今日目标）
  app.get('/api/v1/student/goals', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) return res.json(metronome.list(req.user.ref_id));
    const ensured = metronome.ensureToday(student);
    res.json({ ...metronome.list(student.student_id), ensuredToday: ensured.created });
  });

  // 自建微目标（可编辑性：学生可自行增改）
  app.post('/api/v1/student/goals', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) throw Object.assign(new Error('当前账号未绑定学生'), { status: 400 });
    const { content, stage, nodeId } = req.body || {};
    const r = metronome.add(student, { content, stage, nodeId });
    auth.audit(req.user.user_id, req.user.role, 'goal_add', r.id, { stage: r.stage });
    res.json({ ok: true, goal: { ...r } });
  });

  // 改写微目标内容
  app.put('/api/v1/student/goals/:id', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) throw Object.assign(new Error('当前账号未绑定学生'), { status: 400 });
    const r = metronome.update(student.student_id, req.params.id, { content: (req.body || {}).content });
    auth.audit(req.user.user_id, req.user.role, 'goal_update', req.params.id, {});
    res.json(r);
  });

  // 打卡（done / missed；missed 必须写原因——归因分析而非催促）
  app.post('/api/v1/student/goals/:id/checkin', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) throw Object.assign(new Error('当前账号未绑定学生'), { status: 400 });
    const { status, reason } = req.body || {};
    const r = metronome.checkin(student.student_id, req.params.id, { status, reason });
    auth.audit(req.user.user_id, req.user.role, 'goal_checkin', req.params.id, { status, reason: reason || null });
    res.json(r);
  });
};

function draftOf(sessionId) {
  const row = db.get('SELECT draft FROM sessions WHERE session_id=?', [sessionId]);
  return jparse(row ? row.draft : '{}', {});
}

function messagesOf(sessionId) {
  return db
    .all('SELECT * FROM messages WHERE session_id=? ORDER BY created_at', [sessionId])
    .map((m) => ({
      id: m.msg_id, role: m.role, content: m.content, level: m.level,
      intent: m.intent, guard: m.guard, createdAt: m.created_at,
      // 来源可观测：刷新页面后仍能看出历史每条回复由谁生成
      engine: m.engine || null, modelVer: m.model_ver || null,
    }));
}

module.exports.messagesOf = messagesOf;
void now;
