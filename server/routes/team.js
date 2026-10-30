'use strict';
/**
 * M3 团队协同接口（FR-301/302/303/206/403）
 *
 * 学生端：
 *   POST /api/v1/team/standups                       开启/取回当日站会（返回 Git 事实提示）
 *   GET  /api/v1/team/standups/current               当日站会 + 我的答案 + 组内汇总
 *   POST /api/v1/team/standups/:id/answer            提交三问答案（空泛被追问；阻碍转待办）
 *   GET  /api/v1/team/todos                          本组待办
 *   POST /api/v1/team/todos/:id/done                 勾完成
 *   POST /api/v1/team/roleplays                      开始角色扮演（po/customer/judge）
 *   POST /api/v1/team/roleplays/:id/turn             一轮对话（{text} 或 {end:true}）
 *   GET  /api/v1/team/peer-review/facts              本组事实清单（无分数无排名）
 *   POST /api/v1/team/peer-review                    提交互评/自评评语
 *   POST /api/v1/team/retro                          提交小组复盘三栏
 *   GET  /api/v1/team/retro                          查看本组复盘与补学清单
 *   GET  /api/v1/student/weekly                      我的周报
 *
 * 教师端：
 *   GET  /api/v1/teacher/team/overview               团队观察总览
 *   GET  /api/v1/teacher/team/standups?groupId       某组站会明细
 *   GET  /api/v1/teacher/team/roleplays?classId      扮演/答辩预演记录
 *   GET  /api/v1/teacher/team/reviews?groupId        互评全景（仅事实与评语）
 *   GET  /api/v1/teacher/weekly?classId              教师版周报（班级聚合）
 */
const db = require('../db');
const auth = require('../middleware/auth');
const team = require('../core/team');
const stages = require('../core/stages');
const { now } = require('../core/util');

module.exports = function (app) {
  function myStudent(req) {
    const st = auth.studentOf(req.user);
    if (!st) throw Object.assign(new Error('当前账号未绑定学生'), { status: 400 });
    return st;
  }

  /* ---------------- 学生端：站会 ---------------- */
  app.post('/api/v1/team/standups', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    const group = db.get('SELECT * FROM groups WHERE group_id=?', [st.group_id]);
    const r = team.openStandup(st.group_id, {
      sprintNo: group ? group.sprint_no : 1,
      createdBy: st.student_id,
    });
    res.json({
      standupId: r.standup.id, groupId: st.group_id, date: r.standup.standup_date, created: r.created,
      prompt: r.prompt,
    });
  });

  app.get('/api/v1/team/standups/current', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    const sum = team.standupSummary(st.group_id);
    const mine = sum.answers.find((a) => a.studentId === st.student_id) || null;
    res.json({ ...sum, mine });
  });

  app.post('/api/v1/team/standups/:id/answer', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    const { yesterday, today, blocker } = req.body || {};
    const r = team.answerStandup(req.params.id, st.student_id, { yesterday, today, blocker });
    auth.audit(req.user.user_id, req.user.role, 'standup_answer', req.params.id, { vague: r.vague, blocker: !!blocker });
    res.json(r);
  });

  /* ---------------- 学生端：待办 ---------------- */
  app.get('/api/v1/team/todos', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    const rows = db.all(
      'SELECT * FROM team_todos WHERE group_id=? ORDER BY status, created_at DESC LIMIT 50',
      [st.group_id]
    );
    res.json({ todos: rows });
  });

  app.post('/api/v1/team/todos/:id/done', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    const t = db.get('SELECT * FROM team_todos WHERE id=?', [req.params.id]);
    if (!t || t.group_id !== st.group_id) throw Object.assign(new Error('待办不存在'), { status: 404 });
    db.update('team_todos', 'id', t.id, { status: 'done' });
    res.json({ ok: true });
  });

  /* ---------------- 学生端：角色扮演 ---------------- */
  app.post('/api/v1/team/roleplays', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    const r = team.startRoleplay(st.student_id, { role: (req.body || {}).role });
    auth.audit(req.user.user_id, req.user.role, 'roleplay_start', r.id, { role: (req.body || {}).role });
    res.json(r);
  });

  app.post('/api/v1/team/roleplays/:id/turn', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    const body = req.body || {};
    if (body.end) {
      const feedback = team.endRoleplay(req.params.id, st.student_id);
      auth.audit(req.user.user_id, req.user.role, 'roleplay_end', req.params.id, { clarifying: feedback.clarifying });
      return res.json({ ended: true, feedback });
    }
    const r = team.roleplayTurn(req.params.id, st.student_id, body.text);
    res.json(r);
  });

  /* ---------------- 学生端：互评 ---------------- */
  app.get('/api/v1/team/peer-review/facts', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    const group = db.get('SELECT * FROM groups WHERE group_id=?', [st.group_id]);
    res.json({
      groupId: st.group_id,
      sprintNo: group ? group.sprint_no : 1,
      members: team.peerFacts(st.group_id, group ? group.sprint_no : 1),
      guide: '用「他做了什么 + 这对项目造成了什么影响」写评语。系统只提供事实清单，不打分、不排名。',
    });
  });

  app.post('/api/v1/team/peer-review', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    const { revieweeId, note } = req.body || {};
    const target = db.get('SELECT * FROM students WHERE student_id=?', [revieweeId]);
    if (!target || target.group_id !== st.group_id) {
      throw Object.assign(new Error('只能评价本组成员'), { status: 400 });
    }
    const group = db.get('SELECT * FROM groups WHERE group_id=?', [st.group_id]);
    const r = team.submitPeerReview(st.group_id, st.student_id, revieweeId, note, group ? group.sprint_no : 1);
    auth.audit(req.user.user_id, req.user.role, 'peer_review', revieweeId, { vague: r.vague });
    res.json(r);
  });

  /* ---------------- 学生端：复盘 ---------------- */
  app.post('/api/v1/team/retro', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    const group = db.get('SELECT * FROM groups WHERE group_id=?', [st.group_id]);
    const r = team.submitRetro(st.group_id, group ? group.sprint_no : 1, req.body || {});
    auth.audit(req.user.user_id, req.user.role, 'retro_submit', st.group_id, {});
    res.json(r);
  });

  app.get('/api/v1/team/retro', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    const group = db.get('SELECT * FROM groups WHERE group_id=?', [st.group_id]);
    res.json({ retro: team.retroOf(st.group_id, group ? group.sprint_no : 1) });
  });

  /* ---------------- 学生端：小组进度同步（FR-304：组内阶段进度互相可见） ---------------- */
  app.get('/api/v1/team/progress', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    const members = db.all(
      'SELECT student_id, name, role FROM students WHERE group_id=? ORDER BY student_id',
      [st.group_id]
    );
    const group = db.get('SELECT * FROM groups WHERE group_id=?', [st.group_id]);
    const progress = members.map((m) => {
      const s = db.get(
        'SELECT stage, node_id, level, last_at FROM sessions WHERE student_id=? ORDER BY last_at DESC LIMIT 1',
        [m.student_id]
      );
      const openStuck = db.count('help_events', "student_id=? AND status='open'", [m.student_id]);
      const goalsToday = db.count('daily_goals', "student_id=? AND goal_date=date('now') AND status='done'", [m.student_id]);
      const cfg = s ? stages.get(s.stage) : null;
      const nodeTitle = s && cfg ? ((cfg.nodes.find((n) => n.id === s.node_id) || {}).title || (s.node_id === '__done__' ? '本阶段已完成' : '—')) : '—';
      return {
        studentId: m.student_id,
        name: m.name,
        isLeader: m.role === 'leader',
        stage: s ? s.stage : null,
        stageName: cfg ? cfg.name : '尚未开始',
        nodeTitle,
        progressPercent: s && cfg && s.node_id
          ? (s.node_id === '__done__' ? 100 : Math.round(((cfg.nodes.findIndex((n) => n.id === s.node_id) + 1) / cfg.nodes.length) * 100))
          : 0,
        openStuck,
        goalsTodayDone: goalsToday,
        lastActiveAt: s ? s.last_at : null,
      };
    });
    res.json({
      groupId: st.group_id,
      groupName: group ? group.project_name : null,
      sprintNo: group ? group.sprint_no : 1,
      currentStage: group ? group.current_stage : null,
      members: progress,
      note: '组内进度只列事实（阶段、卡点、活跃时间），不评分、不排名。',
    });
  });

  /* ---------------- 学生端：周报 ---------------- */
  app.get('/api/v1/student/weekly', auth.requireAuth, (req, res) => {
    const st = myStudent(req);
    res.json(team.weeklyOfStudent(st.student_id));
  });

  /* ---------------- 教师端：团队观察 ---------------- */
  app.get('/api/v1/teacher/team/overview', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    res.json({ groups: team.teamOverview(req.query.classId || null) });
  });

  app.get('/api/v1/teacher/team/standups', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const { groupId } = req.query;
    if (!groupId) throw Object.assign(new Error('缺少 groupId'), { status: 400 });
    res.json(team.standupSummary(groupId, req.query.date));
  });

  app.get('/api/v1/teacher/team/roleplays', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const { classId } = req.query;
    const rows = db.all(
      `SELECT r.*, s.name AS student_name FROM roleplays r
       LEFT JOIN students s ON s.student_id=r.student_id` +
      (classId ? ' WHERE s.class_id=?' : '') + ' ORDER BY r.created_at DESC LIMIT 100',
      classId ? [classId] : []
    );
    res.json({
      roleplays: rows.map((r) => ({
        id: r.id, studentId: r.student_id, studentName: r.student_name, groupId: r.group_id,
        role: r.role, roleName: (team.ROLES[r.role] || {}).name || r.role,
        status: r.status, turns: r.turns, clarifying: r.clarifying,
        feedback: r.feedback ? JSON.parse(r.feedback) : null, createdAt: r.created_at,
      })),
    });
  });

  app.get('/api/v1/teacher/team/reviews', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const { groupId } = req.query;
    if (!groupId) throw Object.assign(new Error('缺少 groupId'), { status: 400 });
    const group = db.get('SELECT * FROM groups WHERE group_id=?', [groupId]);
    res.json({ reviews: team.reviewOverview(groupId, group ? group.sprint_no : 1) });
  });

  app.get('/api/v1/teacher/weekly', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    res.json(team.weeklyOfClass(req.query.classId || null));
  });

  void now;
};
