'use strict';
/**
 * 种子数据：班级 / 学生 / 小组 / 账号 / 课程知识图谱 / 默认策略 / 演示用过程数据
 * 用法：
 *   node server/db/seed.js            首次或增量（已存在则跳过建基础数据）
 *   node server/db/seed.js --force    清空重建
 *   node server/db/seed.js --scale=1200   生成 1200 人规模压力数据
 */
const fs = require('node:fs');
const path = require('node:path');
const db = require('./index');
const { uid, now } = require('../core/util');
const stages = require('../core/stages');

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
const scaleArg = argv.find((a) => a.startsWith('--scale='));
const SCALE = scaleArg ? parseInt(scaleArg.split('=')[1], 10) : 0;

// ---- 确定性随机（保证多次 seed 结果一致）----
let seedState = 20260920;
function rnd() {
  seedState = (seedState * 1103515245 + 12345) % 2147483648;
  return seedState / 2147483648;
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}
function randInt(a, b) {
  return a + Math.floor(rnd() * (b - a + 1));
}

// ---- 课程知识图谱（二级粒度，覆盖软件工程课程大纲）----
const KNOWLEDGE = [
  // 需求工程
  { id: 'kn_req', name: '需求工程', parent: null, def: '确定系统该做什么的过程，包含获取、分析、规格说明与验证', mis: ['把需求等同于功能列表'], tags: ['CO-1'] },
  { id: 'kn_story', name: '用户故事', parent: 'kn_req', def: '从用户视角描述需求的三段式：作为…我想…以便…', mis: ['把「用户」当角色', '省略「以便」'], tags: ['CO-1'] },
  { id: 'kn_invest', name: 'INVEST', parent: 'kn_req', def: '用户故事质量准则：独立、可协商、有价值、可估算、足够小、可测试', mis: ['把故事写成不可协商的合同'], tags: ['CO-1'] },
  { id: 'kn_ac', name: '验收标准', parent: 'kn_req', def: '判定需求是否完成的 observable 条件，是需求与测试之间的契约', mis: ['使用「快速」「友好」等不可判定表述'], tags: ['CO-1'] },
  { id: 'kn_prio', name: '需求优先级', parent: 'kn_req', def: '按价值与成本为需求排序的方法，如 MoSCoW', mis: ['所有需求都标为必须'], tags: ['CO-1'] },
  // 软件架构
  { id: 'kn_arch', name: '软件架构', parent: null, def: '系统的结构划分与关键决策集合，决定质量属性的上限', mis: ['把架构等同于框架选型'], tags: ['CO-2'] },
  { id: 'kn_quality', name: '质量属性', parent: 'kn_arch', def: '性能、可用性、可扩展性、安全性等非功能需求', mis: ['声称所有质量属性都重要'], tags: ['CO-2'] },
  { id: 'kn_tradeoff', name: '架构权衡', parent: 'kn_arch', def: '在互斥的质量属性之间做出有理由的取舍', mis: ['只讲方案不讲放弃了什么'], tags: ['CO-2'] },
  { id: 'kn_pattern', name: '设计模式', parent: 'kn_arch', def: '针对反复出现的结构问题的可复用解法', mis: ['为了显得专业而堆砌模式'], tags: ['CO-2'] },
  { id: 'kn_dip', name: '依赖倒置', parent: 'kn_arch', def: '高层与低层都依赖抽象，而非高层依赖低层', mis: ['认为就是「多用接口」'], tags: ['CO-2'] },
  // 软件构造
  { id: 'kn_construct', name: '软件构造', parent: null, def: '编码、规范、版本管理与重构的实践集合', mis: ['把写代码等同于构造'], tags: ['CO-3'] },
  { id: 'kn_srp', name: '单一职责', parent: 'kn_construct', def: '一个类只应有一个引起它变化的原因', mis: ['认为「类越小越好」'], tags: ['CO-3'] },
  { id: 'kn_naming', name: '命名规范', parent: 'kn_construct', def: '用名称承载意图与领域信息，减少认知负担', mis: ['使用 data/info/manager 等无信息量词汇'], tags: ['CO-3'] },
  { id: 'kn_git', name: 'Git 分支模型', parent: 'kn_construct', def: '主干 + 特性分支 + 合并请求的协作方式', mis: ['长期不合并，最后一天集中处理冲突'], tags: ['CO-3'] },
  { id: 'kn_commit', name: '提交信息', parent: 'kn_construct', def: '记录「改了什么」与「为什么改」的最小决策文档', mis: ['写「修改」「更新」等零信息量内容'], tags: ['CO-3'] },
  { id: 'kn_refactor', name: '重构', parent: 'kn_construct', def: '在不改变外部行为的前提下改善内部结构', mis: ['重构与改功能同时进行'], tags: ['CO-3'] },
  // 软件测试
  { id: 'kn_test', name: '软件测试', parent: null, def: '通过执行来验证行为是否符合预期的活动', mis: ['把测试当成交付前的最后一步'], tags: ['CO-4'] },
  { id: 'kn_equiv', name: '等价类划分', parent: 'kn_test', def: '把输入按处理方式分组，每组取代表值测试', mis: ['只划分有效类，忽略无效类'], tags: ['CO-4'] },
  { id: 'kn_boundary', name: '边界值分析', parent: 'kn_test', def: '在等价类边界及其两侧取值测试，捕捉差一错误', mis: ['只测边界值本身，不测两侧'], tags: ['CO-4'] },
  { id: 'kn_coverage', name: '覆盖率', parent: 'kn_test', def: '被测试执行到的代码比例，分语句/分支/路径覆盖', mis: ['把覆盖率当作测试目标而非结果'], tags: ['CO-4'] },
  { id: 'kn_regression', name: '回归测试', parent: 'kn_test', def: '改动后重跑既有用例，确认未破坏已有行为', mis: ['只测新功能，不重跑老用例'], tags: ['CO-4'] },
  { id: 'kn_defect', name: '缺陷定位', parent: 'kn_test', def: '用现象→原因排序→验证的链路缩小问题范围', mis: ['凭直觉改一处就重跑'], tags: ['CO-4'] },
  // 项目管理
  { id: 'kn_pm', name: '项目管理', parent: null, def: '在限定时间与资源内组织团队交付的流程与方法', mis: ['把项目管理等同于排期表'], tags: ['CO-5'] },
  { id: 'kn_scrum', name: 'Scrum 角色', parent: 'kn_pm', def: '产品负责人、Scrum Master、开发团队三类角色与职责', mis: ['把 Scrum Master 当成组长'], tags: ['CO-5'] },
  { id: 'kn_sprint', name: 'Sprint', parent: 'kn_pm', def: '固定长度的迭代周期，默认两周，产出可交付增量', mis: ['Sprint 中途随意加入需求'], tags: ['CO-5'] },
  { id: 'kn_point', name: '故事点', parent: 'kn_pm', def: '相对规模估算单位，不含绝对工时', mis: ['把故事点直接换算成小时'], tags: ['CO-5'] },
  { id: 'kn_standup', name: '站会', parent: 'kn_pm', def: '每日同步三问：昨天做了什么、今天做什么、有什么阻碍', mis: ['站会变成向组长汇报'], tags: ['CO-5'] },
  { id: 'kn_review', name: 'Sprint 评审', parent: 'kn_pm', def: '向利益相关方演示增量并收集反馈', mis: ['评审变成进度汇报会'], tags: ['CO-5'] },
  { id: 'kn_retro', name: 'Sprint 回顾', parent: 'kn_pm', def: '复盘流程并产出可执行的改进行动', mis: ['复盘变成追责会'], tags: ['CO-5'] },
  { id: 'kn_debt', name: '技术债', parent: 'kn_pm', def: '为赶进度而接受的次优设计及其后续代价', mis: ['认为技术债总能以后再还'], tags: ['CO-5'] },
  // 工程实践
  { id: 'kn_ci', name: '持续集成', parent: null, def: '频繁合并并在每次合并后自动构建与测试', mis: ['认为装了 Jenkins 就算 CI'], tags: ['CO-6'] },
  { id: 'kn_cicd', name: 'CI/CD', parent: 'kn_ci', def: '持续集成延伸到持续交付/部署的自动化流水线', mis: ['把自动部署等同于持续交付'], tags: ['CO-6'] },
  { id: 'kn_codereview', name: '代码评审', parent: 'kn_ci', def: '由他人检查改动以发现缺陷与传递知识', mis: ['评审只关注格式与命名'], tags: ['CO-6'] },
];

const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜'.split('');
const GIVEN = ['一鸣', '子涵', '思远', '雨桐', '嘉禾', '博文', '明轩', '若曦', '天宇', '晨曦', '语彤', '泽宇', '欣然', '梓萱', '俊杰', '晓彤', '伟诚', '雅静', '浩然', '婉清'];
const PROJECTS = [
  '校园二手书交易平台', '实验室设备预约系统', '课程作业互评平台', '食堂人流预测小程序',
  '社团活动报名系统', '自习室座位管理系统', '校园失物招领平台', '毕业论文进度跟踪',
  '校园快递代取代送', '校友导师匹配系统',
];

function seedKnowledge() {
  for (const k of KNOWLEDGE) {
    const parent = k.parent ? db.get('SELECT name FROM knowledge_nodes WHERE node_id=?', [k.parent]) : null;
    db.run(
      `INSERT INTO knowledge_nodes (node_id, name, parent_id, level, definition, misconceptions, resources, target_ids, keywords, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(node_id) DO UPDATE SET
         name=excluded.name, definition=excluded.definition, updated_at=excluded.updated_at`,
      [
        k.id, k.name, k.parent, k.parent ? 2 : 1, k.def,
        JSON.stringify(k.mis), JSON.stringify(['课程讲义 第' + (randInt(2, 9)) + '章']),
        JSON.stringify(k.tags), JSON.stringify([k.name]), now(),
      ]
    );
    void parent;
  }
}

function seedClassesAndStudents() {
  const plan = SCALE
    ? [{ id: 'SE-2026-A', name: '软件工程 A班（试点）', n: Math.min(40, SCALE) }].concat(
        Array.from({ length: Math.ceil((SCALE - Math.min(40, SCALE)) / 60) }, (_, i) => ({
          id: 'SE-2026-' + String.fromCharCode(66 + i),
          name: '软件工程 ' + String.fromCharCode(66 + i) + '班',
          n: 60,
        }))
      )
    : [
        { id: 'SE-2026-A', name: '软件工程 A班（试点）', n: 40 },
        { id: 'SE-2026-B', name: '软件工程 B班', n: 60 },
        { id: 'SE-2026-C', name: '软件工程 C班', n: 60 },
      ];

  db.insert('classes', {
    class_id: 'SE-2026-A', name: '软件工程 A班（试点）', course: '软件工程',
    teacher_id: 'T001', term: '2026-2027-1', created_at: now(),
  });
  for (const c of plan.slice(1)) {
    db.run(
      `INSERT INTO classes (class_id, name, course, teacher_id, term, created_at) VALUES (?,?,?,?,?,?)
       ON CONFLICT(class_id) DO NOTHING`,
      [c.id, c.name, '软件工程', 'T001', '2026-2027-1', now()]
    );
  }

  let idx = 0;
  for (const c of plan) {
    const groupCount = Math.ceil(c.n / 4);
    for (let gi = 0; gi < groupCount; gi++) {
      const gid = `${c.id}-G${String(gi + 1).padStart(2, '0')}`;
      const sprintEnd = new Date(Date.now() + (gi % 3 + 1) * 24 * 3600 * 1000).toISOString();
      db.run(
        `INSERT INTO groups (group_id, project_name, sprint_no, current_stage, class_id, sprint_end, created_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(group_id) DO NOTHING`,
        [gid, PROJECTS[(gi + idx) % PROJECTS.length], 1 + (gi % 2), pick(stages.keys()), c.id, sprintEnd, now()]
      );
    }
    for (let i = 0; i < c.n; i++) {
      const sid = `${c.id}-S${String(i + 1).padStart(3, '0')}`;
      const gid = `${c.id}-G${String(Math.floor(i / 4) + 1).padStart(2, '0')}`;
      const name = pick(SURNAMES) + pick(GIVEN);
      db.run(
        `INSERT INTO students (student_id, name, class_id, group_id, role, status, created_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(student_id) DO NOTHING`,
        [sid, name, c.id, gid, i % 4 === 0 ? 'leader' : 'student', 'active', now()]
      );
      db.run(
        `INSERT INTO learner_profiles (student_id, base_level, prefer_style, progress, stuck_tags, level_distribution, avg_turns, activity_pattern, emotion_signals, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(student_id) DO NOTHING`,
        [
          sid, rnd() > 0.6 ? '进阶' : '初学', pick(['类比', '示例', '拆解']),
          JSON.stringify({}), JSON.stringify([]), JSON.stringify({}), 0,
          JSON.stringify({}), 0, now(),
        ]
      );
    }
    idx += groupCount;
  }
  return plan;
}

function seedUsers() {
  const users = [
    { id: 'U-T001', username: 'teacher', password: '123456', role: 'teacher', ref: 'T001', name: '张教授', scope: ['SE-2026-A', 'SE-2026-B', 'SE-2026-C'] },
    { id: 'U-TA01', username: 'ta', password: '123456', role: 'ta', ref: 'TA01', name: '李助教', scope: ['SE-2026-A'] },
    { id: 'U-ADM1', username: 'admin', password: '123456', role: 'admin', ref: 'ADM1', name: '系统管理员', scope: [] },
    { id: 'U-S001', username: 's001', password: '123456', role: 'leader', ref: 'SE-2026-A-S001', name: '赵一鸣', scope: [] },
    { id: 'U-S002', username: 's002', password: '123456', role: 'student', ref: 'SE-2026-A-S002', name: '钱子涵', scope: [] },
  ];
  for (const u of users) {
    db.run(
      `INSERT INTO users (user_id, username, password, role, ref_id, name, scope, created_at)
       VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, password=excluded.password`,
      [u.id, u.username, u.password, u.role, u.ref, u.name, JSON.stringify(u.scope), now()]
    );
  }
}

function seedPolicies() {
  const defaults = require('../core/policy').DEFAULT_CAPS;
  for (const [stage, cap] of Object.entries(defaults)) {
    db.run(
      `INSERT INTO policies (policy_id, scope, scope_id, stage, cap_level, active_from, active_to, updated_by, updated_at, note)
       VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      [uid('pol'), 'global', null, stage, cap, null, null, 'system', now(), '默认封顶（对齐说明书 10.3 建议）']
    );
  }
}

/** 生成演示用过程数据：求助事件 + 会话 + 产出物 + 预警 */
function seedProcessData(days = 21) {
  const students = db.all('SELECT * FROM students');
  const sample = students.filter((_, i) => i % 3 === 0); // 约 1/3 学生有过程数据
  const stageKeys = stages.keys();
  const tagPool = KNOWLEDGE.filter((k) => k.parent).map((k) => k.name);

  for (const s of sample) {
    const n = randInt(1, 5);
    for (let i = 0; i < n; i++) {
      const stage = pick(stageKeys);
      const cfg = stages.get(stage);
      const node = pick(cfg.nodes);
      const openedAt = new Date(Date.now() - randInt(0, days) * 24 * 3600 * 1000 - randInt(0, 23) * 3600 * 1000).toISOString();
      const maxLevel = randInt(0, 3);
      const resolved = rnd() > 0.35;
      const turns = randInt(1, 6);
      const eid = uid('evt');
      const sid = uid('ses');
      db.insert('sessions', {
        session_id: sid, student_id: s.student_id, stage, sprint_no: 1,
        title: cfg.name + '导学', node_id: node.id, level: maxLevel, cap_level: 2,
        event_id: eid, channel: 'web', started_at: openedAt, last_at: openedAt,
        ended_at: resolved ? openedAt : null,
      });
      db.insert('help_events', {
        event_id: eid, student_id: s.student_id, session_id: sid, group_id: s.group_id,
        stage, node_id: node.id, title: node.title,
        knowledge_tags: JSON.stringify([pick(tagPool), pick(tagPool)]),
        status: resolved ? 'resolved' : 'open',
        max_level: maxLevel, upgrade_count: randInt(0, 3), turn_count: turns,
        opened_at: openedAt, closed_at: resolved ? openedAt : null,
      });
      // 画像增量
      const p = db.get('SELECT * FROM learner_profiles WHERE student_id=?', [s.student_id]);
      if (p) {
        const dist = JSON.parse(p.level_distribution || '{}');
        dist[String(maxLevel)] = (dist[String(maxLevel)] || 0) + 1;
        db.update('learner_profiles', 'student_id', s.student_id, {
          level_distribution: JSON.stringify(dist),
          avg_turns: Math.round(((p.avg_turns || 0) + turns) / 2),
        });
      }
    }
    // 部分学生有产出物
    if (rnd() > 0.5) {
      const cfg = stages.get(pick(stageKeys));
      db.insert('artifacts', {
        artifact_id: uid('art'), group_id: s.group_id, student_id: s.student_id,
        stage: cfg.key, type: cfg.artifactType,
        content: JSON.stringify({ note: '演示数据', stage: cfg.name }),
        version: 1, prev_version_id: null,
        knowledge_tags: JSON.stringify(cfg.knowledgeTags || []),
        created_at: new Date(Date.now() - randInt(0, days) * 24 * 3600 * 1000).toISOString(),
      });
    }
  }

  // 若干待处理预警
  const alerted = sample.slice(0, Math.min(8, sample.length));
  for (const s of alerted) {
    db.insert('alerts', {
      alert_id: uid('al'), target_type: 'student', target_id: s.student_id,
      rule_id: pick(['no_commit_3d', 'same_point_3', 'deadline_48h']),
      trigger_reason: pick(['连续 3 天无交互', '同一卡点重复求助 3 次', '距交付不足 48 小时未提交产出物']),
      suggest: '建议发送一次轻量确认消息，或指派助教跟进',
      status: 'pending', created_at: new Date(Date.now() - randInt(0, 72) * 3600 * 1000).toISOString(),
    });
  }

  // 一条待审批解锁申请
  const one = sample[0];
  if (one) {
    db.insert('unlock_requests', {
      req_id: uid('req'), student_id: one.student_id, event_id: null,
      target_level: 4, reason: '连续两次卡壳，验收标准为空，希望获得更完整讲解',
      trace: JSON.stringify({ levelTrail: [0, 1, 2] }), decision: 'pending', created_at: now(),
    });
  }
}

/** M2：演示用 Git 提交轨迹（部分小组，含真实感节奏：低信息提交、截止前集中提交等信号） */
function seedGitData() {
  const groups = db.all("SELECT * FROM groups WHERE class_id='SE-2026-A' LIMIT 6");
  const MSGS_GOOD = [
    'feat: 新增按课程搜索接口，因为验收标准要求 3 秒内返回匹配',
    'fix: 修复结果为空时页面白屏，因为空数组没有走占位分支',
    'refactor: 拆分搜索服务为检索与排序两个类，因为职责混杂难以测试',
    'test: 补充空关键词的边界用例，因为等价类划分漏了无效类',
    'feat: 加入到货订阅提醒，因为故事卡约定无结果时给出订阅入口',
    'chore: 统一返回体结构，因为前端解析逻辑重复了三处',
  ];
  const MSGS_BAD = ['修改', 'update', 'fix', '改了点', 'test', '更新'];
  let total = 0;
  groups.forEach((g, gi) => {
    const members = db.all('SELECT name FROM students WHERE group_id=?', [g.group_id]);
    if (!members.length) return;
    const repoId = uid('repo');
    db.insert('git_repos', {
      repo_id: repoId, group_id: g.group_id, platform: 'manual',
      url: `https://git.example.edu.cn/se2026/${g.group_id.toLowerCase()}-project.git`,
      token: null, owner: null, default_branch: 'main',
      status: 'active', last_synced_at: now(), last_error: null, created_at: now(),
    });
    const n = randInt(6, 16);
    // 每组节奏不同：偶数组均匀推进，奇数组有一半提交堆在近 48 小时
    for (let i = 0; i < n; i++) {
      const nearDeadline = gi % 2 === 1 && i > n / 2;
      const hoursAgo = nearDeadline ? randInt(1, 46) : randInt(6, 21 * 24);
      const author = members[randInt(0, members.length - 1)].name;
      const msg = rnd() > 0.35 ? pick(MSGS_GOOD) : pick(MSGS_BAD);
      const sha = Math.floor(rnd() * 0xffffffffffff).toString(16).padStart(12, '0');
      const committedAt = new Date(Date.now() - hoursAgo * 3600000).toISOString();
      try {
        db.run(
          `INSERT INTO git_commits (id, repo_id, group_id, sha, author_name, author_student_id, message, branch, files_changed, additions, deletions, committed_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id, sha) DO NOTHING`,
          [g.group_id + ':' + sha, repoId, g.group_id, sha, author, null, msg, 'main',
            randInt(1, 6), randInt(5, 120), randInt(0, 40), committedAt]
        );
        total++;
      } catch (_) { /* 冲突忽略 */ }
    }
  });
  return total;
}

/** M3：演示用团队协同数据（站会 / 角色扮演 / 互评 / 复盘 / 待办） */
function seedTeamData() {
  const g1 = db.get("SELECT * FROM groups WHERE group_id='SE-2026-A-G01'");
  if (!g1) return;
  const members = db.all("SELECT * FROM students WHERE group_id=? ORDER BY student_id", [g1.group_id]);
  if (!members.length) return;

  // 1) 一场已结束的站会（昨天）
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const prompt = {
    date: yesterday,
    questions: ['昨天做了什么？', '今天准备做什么？', '有什么阻碍？'],
    facts: members.map((m) => ({ studentId: m.student_id, name: m.name, commits48h: 2, recentMessages: ['feat: 新增搜索接口'], active48h: 1 })),
    hint: '回答要落到具体行为。',
  };
  const suId = uid('sd');
  db.insert('standups', {
    id: suId, group_id: g1.group_id, sprint_no: g1.sprint_no, standup_date: yesterday,
    prompt: JSON.stringify(prompt), status: 'closed', created_by: members[0].student_id, created_at: now(),
  });
  const NOTES = [
    ['昨天把搜索接口的边界用例补齐了，因为等价类划分漏了无效类', '今天写排序服务的单测', '无'],
    ['昨天修复了空结果白屏，因为空数组没走占位分支', '今天联调前端', '接口返回的字段和约定不一致，前端总在猜'],
    ['昨天整理了故事卡', '今天继续拆任务', '没什么'],
    ['昨天没动代码，在看资料', '今天补上', '无'],
  ];
  members.slice(0, 4).forEach((m, i) => {
    const [y, t, b] = NOTES[i % NOTES.length];
    db.insert('standup_answers', {
      id: uid('sa'), standup_id: suId, student_id: m.student_id,
      yesterday: y, today: t, blocker: b, vague: /没什么|无$/.test(b) && i === 2 ? 1 : 0,
      created_at: new Date(Date.now() - 86400000 + i * 3600000).toISOString(),
    });
    if (b !== '无' && b !== '没什么') {
      db.insert('team_todos', {
        id: uid('td'), group_id: g1.group_id, student_id: m.student_id, source: 'standup',
        text: '站会阻碍：' + b, status: 'open', created_at: now(),
      });
    }
  });

  // 2) 一场已结束的角色扮演（客户，含观察反馈）
  const rp = require('../core/team').startRoleplay(members[0].student_id, { groupId: g1.group_id, role: 'customer' });
  const rpTurns = [
    '我想先问一下，你们店里现在会员是怎么管理的？',
    '那大概有多少会员？一个月大概新增多少？',
    '好的。那这个小程序要不要支持储值？',
  ];
  for (const t of rpTurns) require('../core/team').roleplayTurn(rp.id, members[0].student_id, t);
  require('../core/team').endRoleplay(rp.id, members[0].student_id);

  // 3) 互评（事实清单 + 行为影响句式评语，无分数）
  const facts = require('../core/team').peerFacts(g1.group_id, g1.sprint_no);
  members.slice(0, 3).forEach((a, i) => {
    const b = members[(i + 1) % members.length];
    db.run(
      `INSERT INTO peer_reviews (id, group_id, sprint_no, reviewer_id, reviewee_id, facts, note, vague, created_at)
       VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(group_id, sprint_no, reviewer_id, reviewee_id) DO NOTHING`,
      [uid('pr'), g1.group_id, g1.sprint_no, a.student_id, b.student_id,
        JSON.stringify((facts.find((f) => f.studentId === b.student_id) || {}).facts || []),
        '他这周主动补齐了边界用例，因为等价类划分漏了无效类，这直接减少了回归阶段的返工。', 0, now()]
    );
  });

  // 4) 小组复盘（G01）
  require('../core/team').submitRetro(g1.group_id, g1.sprint_no, {
    good: '这轮把验收标准写进了故事卡，因为上一轮验收靠口头约定导致扯皮，这次演示一次通过。',
    improve: '接口字段约定还是靠聊天记录，前端经常要猜，导致联调拖了两天。',
    action: '下个 Sprint 第一天由组长在群里发字段约定表，站会检查更新；联调前先过一遍 mock 数据。',
  });

  // 5) 一条站内推送渠道（默认演示；企微 webhook 渠道由教师自行配置）
  db.insert('push_channels', {
    id: uid('ch'), name: '站内通知（默认）', type: 'inbox', webhook: null,
    scope: JSON.stringify(['teachers']), enabled: 1, created_at: now(), updated_at: now(),
  });
}

function main() {
  if (FORCE) {
    const f = db.DB_FILE;
    try {
      fs.rmSync(f);
      fs.rmSync(f + '-wal', { force: true });
      fs.rmSync(f + '-shm', { force: true });
    } catch (_) {
      /* ignore */
    }
    console.log('[seed] 已清空数据库：' + f);
  }

  db.initSchema();
  console.log('[seed] Schema 就绪');

  seedKnowledge();
  console.log(`[seed] 知识图谱 ${KNOWLEDGE.length} 个节点`);

  const plan = seedClassesAndStudents();
  console.log(`[seed] 班级 ${plan.length} 个 / 学生 ${db.count('students')} 人 / 小组 ${db.count('groups')} 个`);

  seedUsers();
  seedPolicies();
  require('../core/redline').ensureDefaults();
  require('../core/llm/prompts').ensureDefaults();
  console.log('[seed] 账号 / 策略 / 红线规则 / 提示词版本 就绪');

  const existing = db.count('help_events');
  if (existing === 0) {
    seedProcessData();
    console.log(`[seed] 演示过程数据：求助事件 ${db.count('help_events')} 条 / 预警 ${db.count('alerts')} 条 / 产出物 ${db.count('artifacts')} 件`);
  } else {
    console.log(`[seed] 已有过程数据 ${existing} 条，跳过演示数据生成（--force 可重建）`);
  }

  if (db.count('git_commits') === 0) {
    const gitCount = seedGitData();
    console.log(`[seed] M2 演示数据：Git 提交 ${gitCount} 条 / 仓库 ${db.count('git_repos')} 个`);
  }

  if (db.count('standups') === 0) {
    seedTeamData();
    console.log(`[seed] M3 演示数据：站会 ${db.count('standups')} 场 / 待办 ${db.count('team_todos')} 项 / 角色扮演 ${db.count('roleplays')} 场 / 互评 ${db.count('peer_reviews')} 条 / 复盘 ${db.count('retrospectives')} 份`);
  }

  console.log('\n[seed] 完成。登录账号：teacher/123456  ta/123456  admin/123456  s001/123456');
  console.log('[seed] 启动服务：npm start  → http://localhost:3000');
}

if (require.main === module) main();
// 允许被服务入口按需调用（云托管空库自愈：临时盘重置后自动重建演示数据）
module.exports = { main };

module.exports = { main, KNOWLEDGE };
