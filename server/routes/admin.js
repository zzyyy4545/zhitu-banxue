'use strict';
/**
 * 后台与运维（FR-701 账号与班级管理 / FR-702 模型与成本治理 / FR-703 审计日志）
 * 另含：FR-108 红线规则热更新、FR-605 提示词版本管理
 */
const db = require('../db');
const auth = require('../middleware/auth');
const redline = require('../core/redline');
const prompts = require('../core/llm/prompts');
const llm = require('../core/llm');
const metrics = require('../core/metrics');
const { now, uid } = require('../core/util');

module.exports = function (app) {
  // 系统概览
  app.get('/api/v1/admin/overview', auth.requireRole('admin'), (req, res) => {
    res.json({
      counts: {
        students: db.count('students'),
        groups: db.count('groups'),
        classes: db.count('classes'),
        sessions: db.count('sessions'),
        helpEvents: db.count('help_events'),
        artifacts: db.count('artifacts'),
        knowledgeNodes: db.count('knowledge_nodes'),
        alerts: db.count('alerts'),
        pendingAlerts: db.count('alerts', "status='pending'"),
        auditLogs: db.count('audit_logs'),
        guardrailLogs: db.count('guardrail_logs'),
      },
      llm: llm.getConfig(),
      llmEnabled: llm.isEnabled(),
      cache: llm.cacheStats(),
      dbFile: db.DB_FILE,
    });
  });

  // FR-702 模型配置
  app.get('/api/v1/admin/llm', auth.requireRole('admin'), (req, res) => {
    res.json({ config: llm.getConfig(), enabled: llm.isEnabled(), cache: llm.cacheStats(), file: llm.CONFIG_FILE });
  });

  app.put('/api/v1/admin/llm', auth.requireRole('admin'), (req, res) => {
    const cfg = req.body || {};
    llm.saveConfig(cfg);
    llm.reload();
    auth.audit(req.user.user_id, 'admin', 'update_llm_config', null, {
      enabled: cfg.enabled, provider: cfg.provider, baseUrl: cfg.baseUrl,
      strongModel: cfg.strongModel, lightModel: cfg.lightModel,
    });
    res.json({ ok: true, config: llm.getConfig(), enabled: llm.isEnabled() });
  });

  // 拉取网关可用模型清单（body 可带临时 baseUrl/apiKey，便于先测后存）
  app.post('/api/v1/admin/llm/models', auth.requireRole('admin'), async (req, res) => {
    const r = await llm.listModels(req.body || {});
    res.json(r);
  });

  // 连通性测试：可用 override 先测再存（body 传 baseUrl/apiKey 即用临时值测试）
  app.post('/api/v1/admin/llm/test', auth.requireRole('admin'), async (req, res) => {
    const r = await llm.testConnection(req.body || {});
    auth.audit(req.user.user_id, 'admin', 'test_llm_connection', null, {
      ok: r.ok, base: r.base, model: r.model, error: r.error,
    });
    res.json(r);
  });

  // 成本日报表
  app.get('/api/v1/admin/cost', auth.requireRole('admin'), (req, res) => {
    const rows = db.all(
      `SELECT date(created_at) AS d, engine, COUNT(*) AS calls,
              SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct,
              SUM(fallback) AS fallbacks, SUM(cached) AS cached, AVG(latency_ms) AS avg_latency
       FROM model_calls GROUP BY d, engine ORDER BY d DESC LIMIT 30`
    );
    res.json({ daily: rows, cache: llm.cacheStats() });
  });

  // 模型调用明细留痕：逐条证明「哪次真的调了模型、用了哪个模型、花了多少 token」
  // 这是排查「配了 Key 却仍在走规则引擎」的第一现场。
  app.get('/api/v1/admin/llm/calls', auth.requireRole('admin'), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 30, 200);
    const rows = db.all('SELECT * FROM model_calls ORDER BY created_at DESC LIMIT ?', [limit]);
    const stat = db.get(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN engine='llm' THEN 1 ELSE 0 END) AS llmCalls,
              SUM(CASE WHEN fallback=1 THEN 1 ELSE 0 END) AS fallbacks,
              SUM(cached) AS cached,
              SUM(prompt_tokens) AS pt, SUM(completion_tokens) AS ct
       FROM model_calls`
    ) || {};
    res.json({ items: rows, stat, cache: llm.cacheStats() });
  });

  // FR-703 审计日志
  app.get('/api/v1/admin/audit', auth.requireRole('admin'), (req, res) => {
    const action = req.query.action || null;
    const rows = db.all(
      `SELECT * FROM audit_logs ${action ? 'WHERE action=?' : ''} ORDER BY created_at DESC LIMIT 200`,
      action ? [action] : []
    );
    res.json({ logs: rows });
  });

  // FR-108 红线规则（可配置、可热更新）
  app.get('/api/v1/admin/redline', auth.requireRole('admin', 'teacher'), (req, res) => {
    res.json({ rules: redline.listRules() });
  });

  app.post('/api/v1/admin/redline', auth.requireRole('admin', 'teacher'), (req, res) => {
    const r = req.body || {};
    if (!r.name || !r.kind) throw Object.assign(new Error('缺少 name 或 kind'), { status: 400 });
    const id = redline.addRule(r);
    auth.audit(req.user.user_id, req.user.role, 'add_redline_rule', id, { name: r.name, kind: r.kind });
    res.json({ ok: true, ruleId: id });
  });

  app.put('/api/v1/admin/redline/:id', auth.requireRole('admin', 'teacher'), (req, res) => {
    const patch = req.body || {};
    if (patch.enabled !== undefined) patch.enabled = patch.enabled ? 1 : 0;
    redline.updateRule(req.params.id, patch);
    auth.audit(req.user.user_id, req.user.role, 'update_redline_rule', req.params.id, patch);
    res.json({ ok: true });
  });

  app.delete('/api/v1/admin/redline/:id', auth.requireRole('admin'), (req, res) => {
    redline.deleteRule(req.params.id);
    auth.audit(req.user.user_id, req.user.role, 'delete_redline_rule', req.params.id, {});
    res.json({ ok: true });
  });

  // FR-605 提示词版本管理
  app.get('/api/v1/admin/prompts', auth.requireRole('admin', 'teacher'), (req, res) => {
    res.json({ versions: prompts.list(req.query.kind || null) });
  });

  app.get('/api/v1/admin/prompts/:id', auth.requireRole('admin', 'teacher'), (req, res) => {
    res.json({ version: prompts.get(req.params.id) });
  });

  app.post('/api/v1/admin/prompts', auth.requireRole('admin', 'teacher'), (req, res) => {
    const { kind, name, content, status, grayScope } = req.body || {};
    if (!kind || !name || !content) throw Object.assign(new Error('缺少 kind / name / content'), { status: 400 });
    const id = prompts.publish({ kind, name, content, status, grayScope, createdBy: req.user.user_id });
    auth.audit(req.user.user_id, req.user.role, 'publish_prompt', id, { kind, name, status });
    res.json({ ok: true, verId: id });
  });

  app.post('/api/v1/admin/prompts/:id/rollback', auth.requireRole('admin', 'teacher'), (req, res) => {
    const v = prompts.rollback(req.params.id);
    auth.audit(req.user.user_id, req.user.role, 'rollback_prompt', req.params.id, { name: v.name });
    res.json({ ok: true, version: { verId: v.ver_id, name: v.name, kind: v.kind } });
  });

  // FR-701 班级管理
  app.get('/api/v1/admin/classes', auth.requireRole('admin'), (req, res) => {
    res.json({
      classes: db.all('SELECT * FROM classes'),
      users: db.all('SELECT user_id, username, role, name, ref_id FROM users'),
    });
  });

  app.post('/api/v1/admin/classes', auth.requireRole('admin'), (req, res) => {
    const { classId, name, teacherId, term } = req.body || {};
    if (!classId || !name) throw Object.assign(new Error('缺少 classId 或 name'), { status: 400 });
    db.run(
      `INSERT INTO classes (class_id, name, course, teacher_id, term, created_at)
       VALUES (?,?,?,?,?,?) ON CONFLICT(class_id) DO UPDATE SET name=excluded.name`,
      [classId, name, '软件工程', teacherId || 'T001', term || null, now()]
    );
    auth.audit(req.user.user_id, 'admin', 'create_class', classId, { name });
    res.json({ ok: true });
  });

  // CSV 导入学生（FR-701 降级通道）
  // M4：同时创建登录账号（导入即可登录），已有账号不覆盖密码
  app.post('/api/v1/admin/students/import', auth.requireRole('admin'), (req, res) => {
    const { rows, defaultPassword } = req.body || {};
    if (!Array.isArray(rows)) throw Object.assign(new Error('rows 必须是数组'), { status: 400 });
    let ok = 0;
    let accounts = 0;
    for (const r of rows) {
      if (!r.studentId || !r.name) continue;
      db.run(
        `INSERT INTO students (student_id, name, class_id, group_id, role, status, created_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(student_id) DO UPDATE SET name=excluded.name`,
        [r.studentId, r.name, r.classId || null, r.groupId || null, r.role || 'student', 'active', now()]
      );
      ok++;
      // 登录账号：username = 学号，默认密码可指定（演示环境为 123456）
      const role = r.role === 'leader' ? 'leader' : 'student';
      const u = db.get('SELECT user_id FROM users WHERE username=?', [r.studentId]);
      if (!u) {
        db.insert('users', {
          user_id: uid('u'), username: r.studentId,
          password: r.password || defaultPassword || '123456',
          role, ref_id: r.studentId, name: r.name,
          scope: null, created_at: now(),
        });
        accounts++;
      }
    }
    auth.audit(req.user.user_id, 'admin', 'import_students', null, { count: ok, accountsCreated: accounts });
    res.json({ ok: true, imported: ok, accountsCreated: accounts });
  });

  /* ==================== FR-701 账号生命周期管理 ==================== */

  // 账号列表
  app.get('/api/v1/admin/users', auth.requireRole('admin'), (req, res) => {
    const rows = db.all(
      `SELECT user_id, username, role, name, ref_id, scope, created_at,
              CASE WHEN status IS NULL THEN 'active' ELSE status END AS status
       FROM users ORDER BY role, username LIMIT 500`
    );
    res.json({ users: rows });
  });

  // 创建账号（教师 / 助教 / 管理员 / 学生均可）
  app.post('/api/v1/admin/users', auth.requireRole('admin'), (req, res) => {
    const { username, password, role, name, refId, studentId, classId, scope } = req.body || {};
    if (!username || !password || !role) throw Object.assign(new Error('缺少 username / password / role'), { status: 400 });
    if (!['student', 'leader', 'ta', 'teacher', 'admin'].includes(role)) {
      throw Object.assign(new Error('role 只能取 student/leader/ta/teacher/admin'), { status: 400 });
    }
    const dup = db.get('SELECT user_id FROM users WHERE username=?', [username]);
    if (dup) throw Object.assign(new Error('用户名已存在：' + username), { status: 400 });

    // 学生 / 组长账号：refId 兼容 studentId 写法，并联动 students 表（FR-701）
    const sid = refId || studentId || null;
    let linked = false;
    if (sid && ['student', 'leader'].includes(role)) {
      const exists = db.get('SELECT student_id FROM students WHERE student_id=?', [sid]);
      if (!exists) {
        db.run(
          `INSERT INTO students (student_id, name, class_id, group_id, role, status, created_at)
           VALUES (?,?,?,?,?,?,?)`,
          [sid, name || username, classId || null, null, role === 'leader' ? 'leader' : 'student', 'active', now()]
        );
        linked = true;
      } else if (name) {
        // 已存在则只同步姓名，避免覆盖班级/小组归属
        db.run('UPDATE students SET name=? WHERE student_id=?', [name, sid]);
      }
    }

    const id = uid('u');
    db.insert('users', {
      user_id: id, username, password, role,
      ref_id: sid, name: name || username,
      scope: Array.isArray(scope) ? JSON.stringify(scope) : null,
      status: 'active', created_at: now(),
    });
    auth.audit(req.user.user_id, 'admin', 'create_user', id, { username, role, refId: sid, studentCreated: linked });
    res.json({ ok: true, userId: id, refId: sid, studentCreated: linked });
  });

  // 修改账号：重置密码 / 停用启用 / 改名 / 改管辖范围
  app.put('/api/v1/admin/users/:id', auth.requireRole('admin'), (req, res) => {
    // 兼容两种定位方式：user_id 或 username
    let u = db.get('SELECT * FROM users WHERE user_id=?', [req.params.id]);
    if (!u) u = db.get('SELECT * FROM users WHERE username=?', [req.params.id]);
    const targetId = u ? u.user_id : req.params.id;
    if (!u) throw Object.assign(new Error('账号不存在'), { status: 404 });
    const { password, status, name, scope } = req.body || {};
    const patch = {};
    if (password) patch.password = String(password);
    if (status !== undefined) {
      if (!['active', 'disabled'].includes(status)) throw Object.assign(new Error('status 只能取 active/disabled'), { status: 400 });
      patch.status = status;
    }
    if (name) patch.name = String(name);
    if (scope !== undefined) patch.scope = Array.isArray(scope) ? JSON.stringify(scope) : null;
    if (!Object.keys(patch).length) throw Object.assign(new Error('无可更新字段'), { status: 400 });
    db.update('users', 'user_id', targetId, patch);
    auth.audit(req.user.user_id, 'admin', 'update_user', targetId, {
      password: password ? '***重置***' : undefined, status, name, scope,
    });
    res.json({ ok: true });
  });

  /* ==================== FR-603 数据保留：会话管理 ==================== */

  app.get('/api/v1/admin/sessions', auth.requireRole('admin'), (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = db.all(
      `SELECT s.session_id, s.stage, s.sprint_no, s.level, s.channel, s.started_at, s.last_at,
              s.student_id, st.name AS student_name,
              (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.session_id) AS msg_count
       FROM sessions s LEFT JOIN students st ON st.student_id = s.student_id
       ORDER BY s.last_at DESC LIMIT ?`,
      [limit]
    );
    res.json({ sessions: rows });
  });

  // 数据保留策略（FR-603：删除仅管理员且留审计）
  app.delete('/api/v1/admin/sessions/:id', auth.requireRole('admin'), (req, res) => {
    const s = db.get('SELECT * FROM sessions WHERE session_id=?', [req.params.id]);
    db.run('DELETE FROM messages WHERE session_id=?', [req.params.id]);
    db.run('DELETE FROM sessions WHERE session_id=?', [req.params.id]);
    auth.audit(req.user.user_id, 'admin', 'delete_session', req.params.id, { studentId: s ? s.student_id : null });
    res.json({ ok: true });
  });

  // 护栏日志
  app.get('/api/v1/admin/guardrail', auth.requireRole('admin', 'teacher'), (req, res) => {
    res.json({ logs: db.all('SELECT * FROM guardrail_logs ORDER BY created_at DESC LIMIT 100') });
  });

  // 手动触发主动触达（演示用）
  app.post('/api/v1/admin/outreach', auth.requireRole('admin', 'teacher'), (req, res) => {
    const { studentId, ruleId } = req.body || {};
    const rule = (require('../core/alerts').DEFAULT_RULES).find((r) => r.id === ruleId);
    if (!rule) throw Object.assign(new Error('未知规则'), { status: 400 });
    const r = require('../core/alerts').push(studentId, ruleId, rule.text);
    res.json(r);
  });

  // 系统健康 / 指标快照
  app.get('/api/v1/admin/metrics', auth.requireRole('admin', 'teacher'), (req, res) => {
    res.json({
      resolveRate: metrics.resolveRate({}),
      avgTurns: metrics.avgTurns({}),
      levelDistribution: metrics.levelDistribution({}),
      commitFrequency: metrics.commitFrequency({}),
      teacherWorkload: metrics.teacherWorkload({}),
      guardrail: metrics.guardrailStats({}),
    });
  });
};
