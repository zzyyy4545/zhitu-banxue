'use strict';
const db = require('../db');
const auth = require('../middleware/auth');
const redline = require('../core/redline');
const { LEVEL_NAMES, LEVEL_BRIEF } = require('../core/levelMachine');

module.exports = function (app) {
  /**
   * 公开概览（免登录）
   * 仅供首页 / 展示页使用：只暴露系统运行规模与核心机制，不暴露任何个人信息。
   */
  app.get('/api/v1/public/overview', (req, res) => {
    const cnt = (sql) => {
      try { const r = db.get(sql); return r ? Number(r.c || 0) : 0; } catch (e) { return 0; }
    };
    const rows = (sql) => { try { return db.all(sql); } catch (e) { return []; } };

    const scale = {
      students: cnt('SELECT COUNT(*) c FROM students'),
      groups: cnt('SELECT COUNT(*) c FROM groups'),
      classes: cnt('SELECT COUNT(*) c FROM classes'),
      sessions: cnt('SELECT COUNT(*) c FROM sessions'),
      messages: cnt('SELECT COUNT(*) c FROM messages'),
      helpEvents: cnt('SELECT COUNT(*) c FROM help_events'),
      artifacts: cnt('SELECT COUNT(*) c FROM artifacts'),
      commits: cnt('SELECT COUNT(*) c FROM git_commits'),
      knowledgeNodes: cnt('SELECT COUNT(*) c FROM knowledge_nodes'),
    };

    // 卡点解决率：优先按状态列；无状态列时退化为「已走到 L4 讲透」
    let resolved = 0;
    try {
      const r = db.get("SELECT COUNT(*) c FROM help_events WHERE status IN ('resolved','closed','done')");
      resolved = r ? Number(r.c || 0) : 0;
    } catch (e) {
      try {
        const r = db.get('SELECT COUNT(*) c FROM help_events WHERE level>=4');
        resolved = r ? Number(r.c || 0) : 0;
      } catch (e2) { resolved = 0; }
    }

    // 护栏/红线拦截次数 —— 证明「不代做」不是口号，而是真的拦下来过
    const guardBlocks = cnt("SELECT COUNT(*) c FROM guardrail_logs WHERE result='reject'");

    // 干预层级分布 —— 证明 L0–L4 梯度真在按求助深度运转，而非固定给答案
    const levelDist = [0, 0, 0, 0, 0];
    for (const r of rows('SELECT max_level, COUNT(*) c FROM help_events GROUP BY max_level')) {
      const i = Number(r.max_level);
      if (i >= 0 && i <= 4) levelDist[i] = Number(r.c || 0);
    }

    // 逐级解锁次数：证明「反复求助会回落」机制真的触发过
    const downgraded = cnt('SELECT COUNT(*) c FROM help_events WHERE upgrade_count>0');

    let rules = [];
    try {
      rules = redline.listRules().map((r) => ({
        id: r.rule_id || r.id,
        name: r.name || '',
        desc: r.max_level != null ? '触发时介入上限 L' + r.max_level : '',
      }));
    } catch (e) { rules = []; }

    res.json({
      scale,
      resolved,
      resolveRate: scale.helpEvents ? Math.round((resolved / scale.helpEvents) * 1000) / 10 : 0,
      levelDist,
      downgraded,
      guardBlocks,
      levels: LEVEL_NAMES.map((name, i) => ({ level: i, name, brief: LEVEL_BRIEF[i] || '' })),
      redlines: rules,
    });
  });

  // 登录
  app.post('/api/v1/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      const e = new Error('缺少用户名或密码');
      e.status = 400;
      throw e;
    }
    const u = db.get(
      `SELECT * FROM users WHERE username=? AND password=?
       AND (status IS NULL OR status='active')`,
      [username, password]
    );
    if (!u) {
      const disabled = db.get('SELECT user_id FROM users WHERE username=? AND status=?', [username, 'disabled']);
      const e = new Error(disabled ? '该账号已被停用，请联系管理员' : '用户名或密码错误');
      e.status = 401;
      throw e;
    }
    const token = auth.issueToken(u);
    auth.audit(u.user_id, u.role, 'login', u.user_id, { username });
    res.json({
      token,
      user: {
        userId: u.user_id, username: u.username, name: u.name, role: u.role, refId: u.ref_id,
      },
    });
  });

  // 当前登录者
  app.get('/api/v1/me', auth.requireAuth, (req, res) => {
    const u = req.user;
    let extra = {};
    if (u.role === 'student' || u.role === 'leader') {
      const s = db.get('SELECT * FROM students WHERE student_id=?', [u.ref_id]);
      const g = s ? db.get('SELECT * FROM groups WHERE group_id=?', [s.group_id]) : null;
      extra = { student: s, group: g };
    }
    res.json({
      user: {
        userId: u.user_id, username: u.username, name: u.name, role: u.role, refId: u.ref_id,
        scope: JSON.parse(u.scope || '[]'),
      },
      ...extra,
    });
  });

  app.post('/api/v1/auth/logout', auth.requireAuth, (req, res) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (token) auth.TOKENS.delete(token);
    res.json({ ok: true });
  });
};
