'use strict';
/**
 * M2 工具层接口（规格说明书 3.5 工具层：让智能体「能做」而非仅「会说」）
 *
 * 学生端：
 *   POST /api/v1/tools/static-check        静态检查（FR-104 ④：问题清单 + 规范条目）
 *   POST /api/v1/tools/run-tests            单测执行（node:test 沙箱，FR-204）
 *   GET  /api/v1/tools/my-runs              我的工具使用留痕
 *   GET  /api/v1/student/git               本组提交轨迹（学生视角）
 * 教师端：
 *   POST /api/v1/teacher/git/repos         登记小组 Git 仓库（只读）
 *   GET  /api/v1/teacher/git/repos          仓库列表
 *   POST /api/v1/teacher/git/repos/:id/sync  同步提交轨迹（平台 API）
 *   POST /api/v1/teacher/git/import         手工导入提交记录（降级通道）
 *   GET  /api/v1/teacher/git/analysis       提交轨迹分析看板
 *   GET  /api/v1/teacher/tool-runs          工具使用统计
 */
const db = require('../db');
const auth = require('../middleware/auth');
const staticCheck = require('../core/tools/staticCheck');
const unitTest = require('../core/tools/unitTest');
const git = require('../core/tools/git');
const { uid, now, jparse } = require('../core/util');

module.exports = function (app) {
  // ---------------- 学生端：静态检查 ----------------
  app.post('/api/v1/tools/static-check', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    const { code, filename, language, sessionId, disabled } = req.body || {};
    const r = staticCheck.run(code, { filename, language, disabled });
    const runId = staticCheck.logRun({
      studentId: student ? student.student_id : null,
      groupId: student ? student.group_id : null,
      sessionId: sessionId || null,
      ok: r.summary.bySeverity.error === 0,
      summary: { issues: r.summary.totalIssues, bySeverity: r.summary.bySeverity, language: r.summary.language, disabled: r.summary.disabledRules },
    });
    auth.audit(req.user.user_id, req.user.role, 'static_check', runId, { issues: r.summary.totalIssues });
    res.json({ runId, ...r });
  });

  // ---------------- 学生端：静态检查规则目录（检查了什么、依据什么） ----------------
  app.get('/api/v1/tools/static-rules', auth.requireAuth, (req, res) => {
    res.json({ rules: staticCheck.catalog() });
  });

  // ---------------- 学生端：单测执行 ----------------
  app.post('/api/v1/tools/run-tests', auth.requireAuth, async (req, res) => {
    const student = auth.studentOf(req.user);
    const { files, entry, coverage, sessionId, timeoutMs } = req.body || {};
    const r = await unitTest.runTests(files, {
      entry,
      coverage: !!coverage,
      timeoutMs: Math.min(30000, Math.max(3000, Number(timeoutMs) || 15000)),
    });
    const runId = unitTest.logRun({
      studentId: student ? student.student_id : null,
      groupId: student ? student.group_id : null,
      sessionId: sessionId || null,
      ok: r.ok,
      summary: { tests: r.tests, pass: r.pass, fail: r.fail, timedOut: !!r.timedOut, durationMs: r.durationMs },
    });
    auth.audit(req.user.user_id, req.user.role, 'run_tests', runId, { tests: r.tests, fail: r.fail });
    res.json({ runId, ...r, note: '我只负责运行和报告结果——测试文件必须由你自己编写（FR-204 红线：不输出完整测试文件）。' });
  });

  // ---------------- 学生端：工具使用留痕 ----------------
  app.get('/api/v1/tools/my-runs', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) return res.json({ runs: [] });
    const rows = db.all(
      'SELECT * FROM tool_runs WHERE student_id=? ORDER BY created_at DESC LIMIT 20',
      [student.student_id]
    );
    res.json({
      runs: rows.map((r) => ({ ...r, summary: jparse(r.summary, {}), toolName: TOOL_NAMES[r.tool] || r.tool })),
    });
  });

  // ---------------- 学生端：本组提交轨迹 ----------------
  app.get('/api/v1/student/git', auth.requireAuth, (req, res) => {
    const student = auth.studentOf(req.user);
    if (!student) throw Object.assign(new Error('当前账号未绑定学生'), { status: 400 });
    if (!student.group_id) return res.json({ hasGroup: false, analysis: null });
    const a = git.groupAnalysis(student.group_id);
    res.json({
      hasGroup: true,
      analysis: {
        ...a,
        commits: a.commits.slice(0, 50).map((c) => ({
          sha: c.sha.slice(0, 8), author: c.author_name, message: c.message,
          branch: c.branch, committedAt: c.committed_at,
        })),
        repos: a.repos.map((r) => ({ platform: r.platform, status: r.status, lastSyncedAt: r.last_synced_at })),
      },
      note: '成员分布只列事实（谁提交了几次），不做贡献评分与排名——评价由小组自评互评完成（FR-303）。',
    });
  });

  // ---------------- 教师端：Git 仓库登记与同步 ----------------
  app.post('/api/v1/teacher/git/repos', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const { groupId, platform, url, token, defaultBranch } = req.body || {};
    const r = git.addRepo({ groupId, platform, url, token, defaultBranch });
    auth.audit(req.user.user_id, req.user.role, 'git_add_repo', r.repoId, { groupId, platform });
    res.json(r);
  });

  app.get('/api/v1/teacher/git/repos', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const repos = git.listRepos({ groupId: req.query.groupId || null }).map((r) => ({
      repoId: r.repo_id, groupId: r.group_id, platform: r.platform, url: r.url,
      owner: r.owner, status: r.status, lastSyncedAt: r.last_synced_at, lastError: r.last_error,
      commits: db.count('git_commits', 'repo_id=?', [r.repo_id]),
    }));
    res.json({ repos });
  });

  app.post('/api/v1/teacher/git/repos/:id/sync', auth.requireRole('teacher', 'ta', 'admin'), async (req, res) => {
    const r = await git.syncRepo(req.params.id);
    db.insert('tool_runs', {
      run_id: uid('run'),
      tool: 'git_sync', student_id: null,
      group_id: (db.get('SELECT group_id FROM git_repos WHERE repo_id=?', [req.params.id]) || {}).group_id,
      session_id: null, ok: r.ok ? 1 : 0, summary: r, created_at: now(),
    });
    auth.audit(req.user.user_id, req.user.role, 'git_sync', req.params.id, { ok: r.ok });
    res.json(r);
  });

  // ---------------- 教师端：手工导入（降级通道） ----------------
  app.post('/api/v1/teacher/git/import', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const { groupId, raw } = req.body || {};
    const r = git.importCommits({ groupId, raw });
    db.insert('tool_runs', {
      run_id: uid('run'),
      tool: 'git_import', student_id: null, group_id: groupId, session_id: null,
      ok: 1, summary: r, created_at: now(),
    });
    auth.audit(req.user.user_id, req.user.role, 'git_import', groupId, { imported: r.imported });
    res.json(r);
  });

  // ---------------- 教师端：提交轨迹分析 ----------------
  app.get('/api/v1/teacher/git/analysis', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const r = git.analysis({ classId: req.query.classId || null, groupId: req.query.groupId || null });
    res.json({
      ...r,
      note: '提交轨迹为只读快照；成员分布只列事实不评分；「临近截止集中提交」等信号仅提示节奏，不作诚信结论（FR-604：结论权归教师）。',
    });
  });

  app.get('/api/v1/teacher/git/groups/:id/commits', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const { from, to } = req.query;
    res.json({ analysis: git.groupAnalysis(req.params.id, { from: from || null, to: to || null }) });
  });

  // ---------------- 教师端：单组提交轨迹分析报告（JSON / 文本导出） ----------------
  app.get('/api/v1/teacher/git/report', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const { groupId, from, to, format } = req.query;
    if (!groupId) throw Object.assign(new Error('缺少 groupId'), { status: 400 });
    const r = git.exportReport(groupId, { from: from || null, to: to || null });
    auth.audit(req.user.user_id, req.user.role, 'git_report', groupId, { format: format || 'json' });
    if (format === 'text') {
      return res.text(r.text);
    }
    res.json(r);
  });

  // ---------------- 教师端：工具使用统计 ----------------
  app.get('/api/v1/teacher/tool-runs', auth.requireRole('teacher', 'ta', 'admin'), (req, res) => {
    const byTool = db.all(
      'SELECT tool, COUNT(*) AS c, SUM(ok) AS ok FROM tool_runs GROUP BY tool'
    ).map((r) => ({ tool: r.tool, toolName: TOOL_NAMES[r.tool] || r.tool, count: r.c, ok: r.ok || 0 }));
    const recent = db.all(
      `SELECT t.*, s.name AS student_name FROM tool_runs t
       LEFT JOIN students s ON s.student_id = t.student_id
       ORDER BY t.created_at DESC LIMIT 50`
    ).map((r) => ({ ...r, summary: jparse(r.summary, {}) }));
    res.json({ byTool, recent });
  });
};

const TOOL_NAMES = {
  static: '静态检查',
  unittest: '单测执行',
  git_sync: 'Git 同步',
  git_import: 'Git 手工导入',
};
