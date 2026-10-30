'use strict';
/**
 * M3 团队协同核心（FR-301 站会助手 / FR-302 角色扮演 / FR-303 互评引导 / FR-206 复盘沉淀 / FR-403 周报）
 *
 * 红线（全部落在本模块的判定逻辑里，不靠提示词自觉）：
 *   - 站会：不代填记录（答案必须由学生提交）；不评价成员贡献高低
 *   - 角色扮演：结束后必给观察反馈，含至少 2 条具体改进建议
 *   - 互评：只给事实清单与引导问题，不含任何评分或排序；评语中出现打分/排名意图直接拒绝
 *   - 复盘：正文由学生自写，系统只聚合成长档案与补学清单
 */
const db = require('../db');
const { uid, now, dayKey, jparse } = require('./util');

/* ==================== FR-301 站会助手 ==================== */

/** 空泛回答判定：太短 / 万金油话术 */
const VAGUE_RE = /^(没什么|还行|都挺好|正常|没问题|不知道|没啥|凑合)[。.!！~\s]*$/;

function isVague(text) {
  const t = String(text || '').trim();
  return t.length < 8 || VAGUE_RE.test(t);
}

/** 汇总组内成员近 48h 提交与任务变更，生成三问提示（提示与 Git 提交数据一致，FR-301 验收） */
function buildStandupPrompt(groupId) {
  const members = db.all(
    'SELECT student_id, name FROM students WHERE group_id=? AND status=\'active\'',
    [groupId]
  );
  const facts = [];
  for (const m of members) {
    // Git 提交按 author_name 尽力匹配（与 git.js 同一口径）
    const rows = db.all(
      `SELECT message, committed_at FROM git_commits
       WHERE group_id=? AND (author_student_id=? OR author_name=?)
         AND committed_at >= datetime('now','-48 hours')
       ORDER BY committed_at DESC LIMIT 5`,
      [groupId, m.student_id, m.name]
    );
    // 近 48h 会话活动
    const act = db.get(
      `SELECT COUNT(*) AS c FROM sessions WHERE student_id=? AND last_at >= datetime('now','-48 hours')`,
      [m.student_id]
    );
    facts.push({
      studentId: m.student_id,
      name: m.name,
      commits48h: rows.length,
      recentMessages: rows.map((r) => r.message),
      active48h: act ? act.c : 0,
    });
  }
  const prompt = {
    date: dayKey(),
    questions: [
      '昨天做了什么？（对照下方你们组的真实提交记录说，别凭印象）',
      '今天准备做什么？',
      '有什么阻碍？没有就说「无」，有就具体说卡在哪一步。',
    ],
    facts,
    hint: '提示：回答要落到具体行为。说「改了点东西」不算回答——说清改了什么、为什么改。',
  };
  return prompt;
}

/** 创建/取回当日站会（同组同日唯一） */
function openStandup(groupId, { sprintNo, createdBy } = {}) {
  const date = dayKey();
  const exist = db.get('SELECT * FROM standups WHERE group_id=? AND standup_date=?', [groupId, date]);
  if (exist) {
    return { standup: exist, prompt: jparse(exist.prompt, {}), created: false };
  }
  const prompt = buildStandupPrompt(groupId);
  const id = uid('sd');
  db.insert('standups', {
    id,
    group_id: groupId,
    sprint_no: sprintNo || 1,
    standup_date: date,
    prompt: JSON.stringify(prompt),
    status: 'open',
    created_by: createdBy || null,
    created_at: now(),
  });
  return { standup: db.get('SELECT * FROM standups WHERE id=?', [id]), prompt, created: true };
}

/**
 * 提交站会三问答案（学生本人提交，系统不代填）
 * - 空泛回答：落库 vague=1 并返回追问话术
 * - 阻碍项非空：100% 落入待办列表 + 同步教师端预警（FR-301 验收）
 */
function answerStandup(standupId, studentId, { yesterday, today, blocker } = {}) {
  const su = db.get('SELECT * FROM standups WHERE id=?', [standupId]);
  if (!su) throw Object.assign(new Error('站会不存在'), { status: 404 });
  const st = db.get('SELECT * FROM students WHERE student_id=?', [studentId]);
  if (!st || st.group_id !== su.group_id) {
    throw Object.assign(new Error('只能回答本组的站会'), { status: 403 });
  }
  const yesterdayS = String(yesterday || '').trim();
  const todayS = String(today || '').trim();
  const blockerS = String(blocker || '').trim();
  if (!yesterdayS && !todayS) {
    throw Object.assign(new Error('昨天做了什么、今天做什么，至少答一项——站会记录必须由你自己填写'), { status: 400 });
  }
  const vague = isVague(yesterdayS) || isVague(todayS) ? 1 : 0;
  const id = uid('sa');
  db.run(
    `INSERT INTO standup_answers (id, standup_id, student_id, yesterday, today, blocker, vague, created_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(standup_id, student_id) DO UPDATE SET
       yesterday=excluded.yesterday, today=excluded.today, blocker=excluded.blocker,
       vague=excluded.vague, created_at=excluded.created_at`,
    [id, standupId, studentId, yesterdayS, todayS, blockerS, vague, now()]
  );

  // 阻碍项 → 待办 + 教师端提醒
  let todoId = null;
  if (blockerS && blockerS !== '无') {
    todoId = uid('td');
    db.insert('team_todos', {
      id: todoId, group_id: su.group_id, student_id: studentId,
      source: 'standup', text: '站会阻碍：' + blockerS, status: 'open', created_at: now(),
    });
    require('./alerts').createAlert({
      targetType: 'group', targetId: su.group_id, ruleId: 'standup_blocker',
      reason: `${st.name} 站会报告阻碍：${blockerS.slice(0, 60)}`,
      suggest: '查看待办列表，判断是否需要安排辅导或调整任务分配',
    });
  }

  return {
    ok: true,
    vague,
    followUp: vague
      ? '你的回答有点空泛。对照你们组的提交记录再说一次：昨天具体改了什么？为什么改？'
      : '已记录。今天的计划里挑一件最重要的事，做完记得回来打卡。',
    todoId,
  };
}

/** 站会汇总：谁答了、阻碍清单、待办 */
function standupSummary(groupId, date) {
  const su = db.get(
    'SELECT * FROM standups WHERE group_id=? AND (standup_date=? OR ? IS NULL) ORDER BY standup_date DESC LIMIT 1',
    [groupId, date || null, date || null]
  );
  if (!su) return { standup: null, answers: [], blockers: [], todos: [] };
  const answers = db.all(
    `SELECT a.*, s.name AS student_name FROM standup_answers a
     LEFT JOIN students s ON s.student_id=a.student_id WHERE a.standup_id=? ORDER BY a.created_at`,
    [su.id]
  );
  const todos = db.all(
    'SELECT * FROM team_todos WHERE group_id=? AND source=? ORDER BY created_at DESC LIMIT 30',
    [groupId, 'standup']
  );
  return {
    standup: { id: su.id, date: su.standup_date, sprintNo: su.sprint_no, status: su.status },
    answers: answers.map((a) => ({
      studentId: a.student_id, name: a.student_name,
      yesterday: a.yesterday, today: a.today, blocker: a.blocker, vague: a.vague,
    })),
    blockers: answers.filter((a) => a.blocker && a.blocker !== '无').map((a) => ({
      studentId: a.student_id, name: a.student_name, blocker: a.blocker,
    })),
    todos,
  };
}

/* ==================== FR-302 角色扮演 ==================== */

const ROLES = {
  po: {
    name: '产品负责人',
    scenario: '我是产品负责人。下学期这门课要做一个「课程互助平台」。现在你有 5 分钟向我提问，把需求弄清楚。我不会主动告诉你细节——你问什么，我答什么。',
  },
  customer: {
    name: '客户',
    scenario: '我是客户，我只知道我要什么，不知道怎么实现。我想要一个「能帮我们店管理会员的微信小程序」。你现在是需求分析师，向我提问。',
  },
  judge: {
    name: '答辩评委',
    scenario: '我是答辩评委。请用 3 分钟介绍你们的项目：解决了什么问题、方案是什么、怎么验证有效。我随时会打断追问。开始吧。',
  },
};

/** 评审约束清单：观察学生是否主动澄清了这些维度 */
const CONSTRAINT_CHECKLIST = [
  { key: 'user', label: '目标用户是谁', re: /用户|谁用|人群|角色|受众/ },
  { key: 'scope', label: '范围与边界（做什么/不做什么）', re: /范围|边界|不做什么|不包括|优先级/ },
  { key: 'data', label: '数据从哪来、存什么', re: /数据|来源|存储|字段|记录/ },
  { key: 'accept', label: '怎么算做完（验收标准）', re: /验收|怎么算|标准|完成|怎么验证|效果/ },
  { key: 'time', label: '时间与交付节点', re: /时间|期限|多久|节点|什么时候|交付/ },
  { key: 'nonfunc', label: '性能/安全等非功能要求', re: /性能|并发|安全|隐私|响应时间|可用/ },
];

const CLARIFY_RE = /[?？]$|[?？]|^(什么|为什么|怎么|如何|哪些|多少|是否|能不能|可不可以|哪个)/;

function startRoleplay(studentId, { groupId, role } = {}) {
  if (!ROLES[role]) throw Object.assign(new Error('角色仅支持：po / customer / judge'), { status: 400 });
  const st = db.get('SELECT * FROM students WHERE student_id=?', [studentId]);
  const id = uid('rp');
  db.insert('roleplays', {
    id,
    group_id: groupId || (st ? st.group_id : null),
    student_id: studentId,
    role,
    scenario: ROLES[role].scenario,
    status: 'active',
    turns: 0,
    clarifying: 0,
    transcript: JSON.stringify([{ who: 'agent', text: ROLES[role].scenario }]),
    created_at: now(),
  });
  return { id, role, roleName: ROLES[role].name, scenario: ROLES[role].scenario };
}

/**
 * 角色扮演一轮对话（规则驱动，角色一致性由话术模板保证）：
 * - 学生提问 → 计入澄清问题数，角色给「部分信息 + 保留一处模糊」
 * - 学生陈述不提问 → 角色坚持模糊，把球踢回去
 */
function roleplayTurn(id, studentId, text) {
  const rp = db.get('SELECT * FROM roleplays WHERE id=?', [id]);
  if (!rp) throw Object.assign(new Error('扮演会话不存在'), { status: 404 });
  if (rp.student_id !== studentId) throw Object.assign(new Error('只能操作本人的扮演会话'), { status: 403 });
  if (rp.status !== 'active') return { ended: true, feedback: jparse(rp.feedback, {}) };
  const t = String(text || '').trim();
  if (!t) throw Object.assign(new Error('说点什么——角色在等你'), { status: 400 });

  const isQuestion = CLARIFY_RE.test(t);
  const transcript = jparse(rp.transcript, []);
  transcript.push({ who: 'student', text: t });

  let reply;
  if (rp.role === 'judge') {
    reply = isQuestion
      ? '这个提问角度可以。但答辩里评委更想听结论和证据——你的依据是什么？继续。'
      : '你说的这些我听到了。追问一句：你怎么证明它有效？拿什么数据说话？';
  } else if (isQuestion) {
    // 角色给部分信息，但永远保留一处模糊（逼学生继续问）
    reply = [
      '这个我可以答一部分：大概的方向是有的，具体细节我也还没完全想好。',
      '这样吧——你如果是我，你觉得这个细节还牵扯到什么？先说说你的判断。',
    ][Math.min(transcript.filter((x) => x.who === 'student').length % 2, 1)];
  } else {
    reply = [
      '嗯，你说的做法听起来可行。不过我关心的是我的业务，不是你的技术。',
      '所以再问一遍：你到底有没有弄清楚我想要什么？哪里不清楚，现在就问。',
      rp.role === 'customer' ? '我不是很懂技术，你刚才说的我没听明白。用我的业务再讲一遍，然后问我还缺什么。' : '',
    ].filter(Boolean)[Math.floor(Math.random() * 2)] || '你还没向我提问。想要弄清需求，先问一个具体的问题。';
  }
  transcript.push({ who: 'agent', text: reply });
  const clarifying = rp.clarifying + (isQuestion ? 1 : 0);
  db.update('roleplays', 'id', id, {
    turns: rp.turns + 1,
    clarifying,
    transcript: JSON.stringify(transcript),
  });
  return { reply, clarifying, turns: rp.turns + 1, isQuestion };
}

/**
 * 结束扮演并生成观察反馈（验收：必给反馈，含至少 2 条具体改进建议）
 * 反馈基于全部对话内容对照约束清单，只做行为观察，不打分。
 */
function endRoleplay(id, studentId) {
  const rp = db.get('SELECT * FROM roleplays WHERE id=?', [id]);
  if (!rp) throw Object.assign(new Error('扮演会话不存在'), { status: 404 });
  if (rp.student_id !== studentId) throw Object.assign(new Error('只能操作本人的扮演会话'), { status: 403 });
  const transcript = jparse(rp.transcript, []);
  const asked = transcript.filter((x) => x.who === 'student').map((x) => x.text).join('\n');

  const covered = CONSTRAINT_CHECKLIST.filter((c) => c.re.test(asked));
  const missed = CONSTRAINT_CHECKLIST.filter((c) => !c.re.test(asked));

  const suggestions = [];
  if (missed.length) {
    suggestions.push(`有 ${missed.length} 个关键维度你没有主动澄清：${missed.map((m) => m.label).join('、')}。下次开场先把问题清单列全，再逐个问。`);
  }
  if (rp.clarifying < 3) {
    suggestions.push(`全程你只提了 ${rp.clarifying} 个澄清问题。需求博弈里，提问密度就是专业度——建议准备至少 6 个问题，按「用户 → 范围 → 验收」的顺序问。`);
  }
  if (covered.length) {
    suggestions.push(`做得好的部分：你主动澄清了「${covered.map((c) => c.label).join('、')}」，这几个维度问得到位，保持。`);
  }
  if (suggestions.length < 2) {
    suggestions.push('角色一致性提醒：对方始终没有给出完整需求，这是故意的——真实客户也是这样。把「从模糊中挖出确定性」当成需求分析的基本功来练。');
  }

  const feedback = {
    roleName: (ROLES[rp.role] || {}).name,
    turns: rp.turns,
    clarifying: rp.clarifying,
    covered: covered.map((c) => c.label),
    missed: missed.map((c) => c.label),
    suggestions: suggestions.slice(0, 4),
    note: '以上是行为观察，不是评分。你问了什么、漏了什么，都在对话留痕里可回溯。',
  };
  db.update('roleplays', 'id', id, { status: 'ended', ended_at: now(), feedback: JSON.stringify(feedback) });
  return feedback;
}

/* ==================== FR-303 贡献度自评与互评 ==================== */

/** 事实清单：基于提交记录、任务闭环、评审参与，只列事实不下结论（红线） */
function peerFacts(groupId, sprintNo) {
  const members = db.all(
    "SELECT student_id, name, role FROM students WHERE group_id=? AND status='active'",
    [groupId]
  );
  return members.map((m) => {
    const commits = db.get(
      'SELECT COUNT(*) AS c, MAX(committed_at) AS last FROM git_commits WHERE group_id=? AND (author_student_id=? OR author_name=?)',
      [groupId, m.student_id, m.name]
    );
    const lowInfo = db.get(
      `SELECT COUNT(*) AS c FROM git_commits WHERE group_id=? AND (author_student_id=? OR author_name=?)
       AND message IN ('修改','update','fix','改了点','test','更新')`,
      [groupId, m.student_id, m.name]
    );
    const closed = db.count('team_todos', "student_id=? AND status='done'", [m.student_id]);
    const openT = db.count('team_todos', "student_id=? AND status='open'", [m.student_id]);
    const standups = db.count('standup_answers', 'student_id=?', [m.student_id]);
    const roleplays = db.count('roleplays', 'student_id=?', [m.student_id]);
    const artifacts = db.count('artifacts', 'student_id=?', [m.student_id]);
    const helps = db.count('help_events', 'student_id=?', [m.student_id]);
    return {
      studentId: m.student_id,
      name: m.name,
      isLeader: m.role === 'leader',
      facts: [
        `提交 ${commits.c || 0} 次（最近一次：${commits.last ? String(commits.last).slice(0, 10) : '无记录'}）`,
        `其中低信息量提交（如「修改」「update」）${lowInfo.c || 0} 次`,
        `产出物提交 ${artifacts} 件`,
        `任务闭环：待办完成 ${closed} 项 / 未完成 ${openT} 项`,
        `站会参与 ${standups} 次，角色扮演/答辩预演 ${roleplays} 次`,
        `发起求助 ${helps} 次`,
      ],
    };
  });
}

/** 评语中夹带评分/排名意图的检测（红线：不给分数建议、不做排名） */
const SCORE_INTENT_RE = /(打分|评分|分数|几分|得分|排名|排第|贡献(最大|最高|最多)|最(差|懒|强|弱)的|[0-9]+(\.[0-9]+)?\s*分)/;

/** 「行为 + 影响」句式引导：评语须包含因果连接 */
const IMPACT_RE = /(因为|由于|导致|使得|所以|帮助了|影响了|减少了|提高了|拖慢了|推进了)/;

function submitPeerReview(groupId, reviewerId, revieweeId, note, sprintNo) {
  if (reviewerId === revieweeId) {
    // 自评同样支持，口径一致
  }
  const noteS = String(note || '').trim();
  if (noteS.length < 10) {
    throw Object.assign(new Error('评语太短。用「他做了什么 + 这对项目造成了什么影响」的句式重写。'), { status: 400 });
  }
  if (SCORE_INTENT_RE.test(noteS)) {
    throw Object.assign(
      new Error('评语里出现了分数或排名的表述。互评只描述事实与影响，不打分、不排序——这是底线。'),
      { status: 400 }
    );
  }
  const vague = IMPACT_RE.test(noteS) ? 0 : 1;
  const facts = (peerFacts(groupId, sprintNo).find((f) => f.studentId === revieweeId) || {}).facts || [];
  db.run(
    `INSERT INTO peer_reviews (id, group_id, sprint_no, reviewer_id, reviewee_id, facts, note, vague, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(group_id, sprint_no, reviewer_id, reviewee_id) DO UPDATE SET
       facts=excluded.facts, note=excluded.note, vague=excluded.vague, created_at=excluded.created_at`,
    [uid('pr'), groupId, sprintNo || 1, reviewerId, revieweeId,
      JSON.stringify(facts), noteS, vague, now()]
  );
  return {
    ok: true,
    vague,
    followUp: vague
      ? '你的评语说了行为，但没说影响。补一句：他的这个行为，让项目的哪一步变好了或变慢了？'
      : '已记录。事实清单和他的提交留痕都保存了，需要时可回溯核对。',
  };
}

/** 组内互评全景（教师端观察用；仍不含任何分数） */
function reviewOverview(groupId, sprintNo) {
  const rows = db.all(
    'SELECT * FROM peer_reviews WHERE group_id=? AND sprint_no=? ORDER BY created_at',
    [groupId, sprintNo || 1]
  );
  return rows.map((r) => {
    const a = db.get('SELECT name FROM students WHERE student_id=?', [r.reviewer_id]);
    const b = db.get('SELECT name FROM students WHERE student_id=?', [r.reviewee_id]);
    return {
      reviewer: r.reviewer_id, reviewerName: a ? a.name : r.reviewer_id,
      reviewee: r.reviewee_id, revieweeName: b ? b.name : r.reviewee_id,
      note: r.note, vague: r.vague, facts: jparse(r.facts, []), createdAt: r.created_at,
    };
  });
}

/* ==================== FR-206 复盘沉淀（小组级） ==================== */

/**
 * 提交小组复盘（正文学生自写）+ 系统聚合成长档案与补学清单
 * 补学清单由「卡点倒推」：组内成员 stuck_tags ∪ 未解决求助事件的知识点标签
 */
function submitRetro(groupId, sprintNo, { good, improve, action } = {}) {
  const goodS = String(good || '').trim();
  const improveS = String(improve || '').trim();
  const actionS = String(action || '').trim();
  if (goodS.length < 10 || improveS.length < 10 || actionS.length < 10) {
    throw Object.assign(
      new Error('三栏都要填，且每栏至少 10 字——复盘正文必须由你们自己写，系统不会代写。'),
      { status: 400 }
    );
  }
  const members = db.all("SELECT student_id, name FROM students WHERE group_id=? AND status='active'", [groupId]);

  // 成长档案：逐成员聚合过程指标（只呈现事实）
  const growth = {};
  const studySet = new Map();
  for (const m of members) {
    const p = db.get('SELECT * FROM learner_profiles WHERE student_id=?', [m.student_id]);
    const stuck = jparse(p ? p.stuck_tags : '[]', []);
    stuck.forEach((t) => studySet.set(t, (studySet.get(t) || 0) + 1));
    growth[m.name] = {
      求助次数: db.count('help_events', 'student_id=?', [m.student_id]),
      未解决卡点: db.count('help_events', "student_id=? AND status='open'", [m.student_id]),
      层级分布: jparse(p ? p.level_distribution : '{}', {}),
      平均解决轮次: p ? p.avg_turns : 0,
      提交次数: db.count('git_commits', 'group_id=? AND (author_student_id=? OR author_name=?)', [groupId, m.student_id, m.name]),
    };
  }
  // 未解决求助事件的知识点标签也进入补学清单
  const openEvents = db.all(
    "SELECT knowledge_tags FROM help_events WHERE group_id IN (SELECT student_id FROM students WHERE group_id=?) AND status='open'",
    [groupId]
  );
  openEvents.forEach((e) => jparse(e.knowledge_tags, []).forEach((t) => studySet.set(t, (studySet.get(t) || 0) + 1)));
  const study_list = [...studySet.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([tag, n]) => ({ knowledge: tag, stuckStudents: n, advice: '从具体卡点倒推这一个知识点，补完立刻回项目里用它一次' }));

  db.run(
    `INSERT INTO retrospectives (id, group_id, sprint_no, good, improve, action, growth, study_list, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(group_id, sprint_no) DO UPDATE SET
       good=excluded.good, improve=excluded.improve, action=excluded.action,
       growth=excluded.growth, study_list=excluded.study_list, created_at=excluded.created_at`,
    [uid('rt'), groupId, sprintNo || 1, goodS, improveS, actionS,
      JSON.stringify(growth), JSON.stringify(study_list), now()]
  );
  // 行动项落入待办（source=retro），下个 Sprint 可检查
  actionS.split(/[；;\n]/).map((s) => s.trim()).filter((s) => s.length > 5).slice(0, 3).forEach((line) => {
    db.insert('team_todos', {
      id: uid('td'), group_id: groupId, student_id: null,
      source: 'retro', text: '复盘行动：' + line, status: 'open', created_at: now(),
    });
  });
  return { ok: true, growth, studyList: study_list, todoHint: '行动项已拆入团队待办，下个 Sprint 第一天先检查。' };
}

function retroOf(groupId, sprintNo) {
  const r = db.get('SELECT * FROM retrospectives WHERE group_id=? AND sprint_no=?', [groupId, sprintNo || 1]);
  if (!r) return null;
  return { good: r.good, improve: r.improve, action: r.action, growth: jparse(r.growth, {}), studyList: jparse(r.study_list, []), createdAt: r.created_at };
}

/* ==================== FR-403 周报 ==================== */

/** 学生版周报：求助主题、卡点分布、推进情况、待办（数据与原始记录一致） */
function weeklyOfStudent(studentId) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const events = db.all(
    'SELECT title, stage, status, max_level, turn_count, opened_at FROM help_events WHERE student_id=? AND opened_at>=? ORDER BY opened_at',
    [studentId, since]
  );
  const tags = {};
  events.forEach((e) => jparse(e.knowledge_tags, []).forEach((t) => { tags[t] = (tags[t] || 0) + 1; }));
  const st = db.get('SELECT * FROM students WHERE student_id=?', [studentId]);
  const commits = st && st.group_id
    ? db.get('SELECT COUNT(*) AS c FROM git_commits WHERE group_id=? AND (author_student_id=? OR author_name=?) AND committed_at>=?',
        [st.group_id, studentId, st.name, since])
    : { c: 0 };
  const todos = st
    ? db.all("SELECT text, status, source FROM team_todos WHERE (student_id=? OR student_id IS NULL) AND group_id=? ORDER BY created_at DESC LIMIT 10",
        [studentId, st.group_id])
    : [];
  const artifacts = db.count('artifacts', 'student_id=? AND created_at>=?', [studentId, since]);
  return {
    since,
    student: { id: studentId, name: st ? st.name : '' },
    helpTopics: events.map((e) => ({ title: e.title, stage: e.stage, status: e.status, turns: e.turn_count })),
    stuckDistribution: tags,
    progress: {
      commits7d: commits.c || 0,
      artifacts7d: artifacts,
      resolved: events.filter((e) => e.status === 'resolved').length,
      open: events.filter((e) => e.status === 'open').length,
    },
    todos,
  };
}

/** 教师版周报：班级聚合，不含单条对话原文（FR-403 验收） */
function weeklyOfClass(classId) {
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const where = classId ? 'AND s.class_id=?' : '';
  const params = classId ? [since, classId] : [since];
  const events = db.all(
    `SELECT e.stage, e.status, e.max_level, COUNT(*) AS c FROM help_events e
     JOIN students s ON s.student_id=e.student_id
     WHERE e.opened_at>=? ${where} GROUP BY e.stage, e.status, e.max_level`,
    params
  );
  const active = db.get(
    `SELECT COUNT(DISTINCT session_id) AS c FROM messages WHERE created_at>=?`,
    [since]
  );
  const total = db.get(
    `SELECT COUNT(*) AS c FROM help_events e JOIN students s ON s.student_id=e.student_id WHERE e.opened_at>=? ${where}`,
    params
  );
  const tagRows = db.all(
    `SELECT e.knowledge_tags, COUNT(*) AS c FROM help_events e
     JOIN students s ON s.student_id=e.student_id
     WHERE e.opened_at>=? ${where} GROUP BY e.knowledge_tags ORDER BY c DESC LIMIT 10`,
    params
  );
  const tags = {};
  tagRows.forEach((r) => jparse(r.knowledge_tags, []).forEach((t) => { tags[t] = (tags[t] || 0) + r.c; }));
  const standups = db.count('standups', 'created_at>=?', [since]);
  const blockers = db.count('team_todos', "source='standup' AND created_at>=?", [since]);
  return {
    since,
    helpTotal: total.c || 0,
    activeSessions7d: active.c || 0,
    standups7d: standups,
    standupBlockers7d: blockers,
    topStuck: Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([t, c]) => ({ knowledge: t, count: c })),
    byStage: events.reduce((acc, e) => {
      acc[e.stage] = acc[e.stage] || { total: 0, resolved: 0 };
      acc[e.stage].total += e.c;
      if (e.status === 'resolved') acc[e.stage].resolved += e.c;
      return acc;
    }, {}),
  };
}

/* ==================== 教师端团队观察聚合 ==================== */

function teamOverview(classId) {
  const groups = db.all(
    'SELECT * FROM groups' + (classId ? ' WHERE class_id=?' : '') + ' ORDER BY group_id LIMIT 60',
    classId ? [classId] : []
  );
  const today = dayKey();
  return groups.map((g) => {
    const members = db.count('students', "group_id=? AND status='active'", [g.group_id]);
    const su = db.get('SELECT * FROM standups WHERE group_id=? AND standup_date=?', [g.group_id, today]);
    const answered = su ? db.count('standup_answers', 'standup_id=?', [su.id]) : 0;
    const blockers = db.count('team_todos', "group_id=? AND source='standup' AND status='open'", [g.group_id]);
    const openTodos = db.count('team_todos', "group_id=? AND status='open'", [g.group_id]);
    const rps = db.count('roleplays', 'group_id=?', [g.group_id]);
    const rpEnded = db.count('roleplays', "group_id=? AND status='ended'", [g.group_id]);
    const reviews = db.count('peer_reviews', 'group_id=?', [g.group_id]);
    const retro = db.get('SELECT sprint_no FROM retrospectives WHERE group_id=? ORDER BY sprint_no DESC LIMIT 1', [g.group_id]);
    return {
      groupId: g.group_id, projectName: g.project_name, sprintNo: g.sprint_no,
      members,
      standupToday: !!su, standupAnswered: answered, standupRate: members ? Math.round((answered / members) * 100) : 0,
      blockers, openTodos,
      roleplays: rps, roleplaysEnded: rpEnded,
      peerReviews: reviews,
      retroDone: !!retro,
    };
  });
}

module.exports = {
  // 站会
  openStandup, answerStandup, standupSummary, buildStandupPrompt, isVague,
  // 角色扮演
  ROLES, startRoleplay, roleplayTurn, endRoleplay, CONSTRAINT_CHECKLIST,
  // 互评
  peerFacts, submitPeerReview, reviewOverview, SCORE_INTENT_RE,
  // 复盘
  submitRetro, retroOf,
  // 周报
  weeklyOfStudent, weeklyOfClass,
  // 教师端
  teamOverview,
};
