'use strict';
/**
 * 主编排：一次求助的完整时序（说明书 4.2）
 *
 * 1 接入 → 2 意图与阶段判定 → 3 历史检索 → 4 策略选择 → 5 检索增强
 * → 6 草稿生成（导学 Agent）→ 7 护栏校验 → 8 规则拦截 → 9 投递与留痕 → 10 闭环判定
 */
const db = require('../db');
const stages = require('./stages');
const orchestrator = require('./orchestrator');
const tutor = require('./tutor');
const { normalizeDraft } = require('./tutor');
const guardrail = require('./guardrail');
const redline = require('./redline');
const policy = require('./policy');
const profile = require('./profile');
const alerts = require('./alerts');
const knowledge = require('./knowledge');
const llm = require('./llm');
const promptsLib = require('./llm/prompts');
const staticCheck = require('./tools/staticCheck');
const { uid, now, hasProgress, detectInjection, detectEmotion, jparse, clampLevel } = require('./util');

/** 从学生消息里抽第一个代码围栏块（``` 或 缩进代码） */
function extractCodeBlock(text) {
  const t = String(text || '');
  const m = t.match(/```[\w-]*\r?\n([\s\S]*?)```/);
  if (m) return { code: m[1], lines: m[1].split(/\r?\n/).filter((l) => l.trim()).length };
  return null;
}

// ---------------- 会话与事件 ----------------

function ensureSession(student, { stage, channel, sprintNo }) {
  const stg = stage || 'requirements';
  // FR-101：30 分钟内的未结束会话默认接续
  const recent = db.get(
    `SELECT * FROM sessions WHERE student_id=? AND ended_at IS NULL
     AND last_at >= datetime('now','-30 minutes') ORDER BY last_at DESC LIMIT 1`,
    [student.student_id]
  );
  if (recent && !stage) return { session: recent, resumed: true };

  const cfg = stages.get(stg) || stages.all()[0];
  const cap = policy.resolveCap({ classId: student.class_id, groupId: student.group_id, stage: stg });
  const group = db.get('SELECT * FROM groups WHERE group_id=?', [student.group_id]);
  const sid = uid('ses');
  const eventId = uid('evt');

  db.insert('sessions', {
    session_id: sid,
    student_id: student.student_id,
    stage: stg,
    sprint_no: (group && group.sprint_no) || sprintNo || 1,
    title: cfg.name + '导学',
    node_id: cfg.nodes[0].id,
    level: 0,
    cap_level: cap.cap,
    event_id: eventId,
    channel: channel || 'web',
    started_at: now(),
    last_at: now(),
  });
  db.insert('help_events', {
    event_id: eventId,
    student_id: student.student_id,
    session_id: sid,
    group_id: student.group_id,
    stage: stg,
    node_id: cfg.nodes[0].id,
    title: cfg.nodes[0].title,
    status: 'open',
    max_level: 0,
    turn_count: 0,
    opened_at: now(),
  });
  return { session: db.get('SELECT * FROM sessions WHERE session_id=?', [sid]), resumed: false };
}

function newEventFor(session, nodeId) {
  const cfg = stages.get(session.stage);
  const node = stages.nodeOf(session.stage, nodeId);
  const id = uid('evt');
  db.insert('help_events', {
    event_id: id,
    student_id: session.student_id,
    session_id: session.session_id,
    group_id: null,
    stage: session.stage,
    node_id: nodeId,
    title: node ? node.title : cfg.name,
    status: 'open',
    max_level: 0,
    turn_count: 0,
    opened_at: now(),
  });
  return id;
}

function closeEvent(eventId, { status = 'resolved', maxLevel, turns, tags }) {
  const ev = db.get('SELECT * FROM help_events WHERE event_id=?', [eventId]);
  if (!ev) return null;
  db.update('help_events', 'event_id', eventId, {
    status,
    max_level: Math.max(maxLevel === undefined ? 0 : maxLevel, ev.max_level || 0),
    turn_count: turns === undefined ? ev.turn_count : turns,
    knowledge_tags: JSON.stringify(tags || jparse(ev.knowledge_tags, [])),
    closed_at: now(),
  });
  const updated = db.get('SELECT * FROM help_events WHERE event_id=?', [eventId]);
  if (status === 'resolved') profile.onEventClosed(ev.student_id, updated);
  return updated;
}

// ---------------- 消息 ----------------

function saveMessage(sessionId, role, content, extra = {}) {
  const id = uid('msg');
  db.insert('messages', {
    msg_id: id,
    session_id: sessionId,
    role,
    content,
    level: extra.level === undefined ? null : extra.level,
    intent: extra.intent || null,
    engine: extra.engine || null,
    prompt_ver: extra.promptVer || null,
    model_ver: extra.modelVer || null,
    guard: extra.guard || null,
    created_at: now(),
  });
  return id;
}

/** 连续未推进轮次（4.1 跃迁条件） */
function noProgressRun(sessionId, eventId) {
  const rows = db.all(
    `SELECT role, content FROM messages WHERE session_id=? ORDER BY created_at DESC LIMIT 12`,
    [sessionId]
  );
  let run = 0;
  for (const r of rows) {
    if (r.role !== 'student') continue;
    if (hasProgress(r.content)) break;
    run++;
  }
  return run;
}

// ---------------- 主流程 ----------------

/**
 * 处理学生消息
 * @returns {{session, reply, level, capped, needUnlock, guard, engine}}
 */
async function handleMessage({ student, sessionId, text, attachments = [], channel = 'web', stage }) {
  const t0 = Date.now();
  const { session, resumed } = sessionId
    ? { session: db.get('SELECT * FROM sessions WHERE session_id=?', [sessionId]), resumed: true }
    : ensureSession(student, { stage, channel });

  if (!session) throw Object.assign(new Error('会话不存在'), { status: 404 });

  // 1 接入：保存学生消息
  saveMessage(session.session_id, 'student', String(text || ''), {});

  // 2–5 调度
  const group = db.get('SELECT * FROM groups WHERE group_id=?', [student.group_id]);
  const r = orchestrator.route({ student, text, session, group, attachments });

  // 阶段切换 → 重置节点与层级（4.1 重置条件）
  if (r.stageSwitched && r.stage !== session.stage) {
    const cfg = stages.get(r.stage);
    if (session.event_id) closeEvent(session.event_id, { status: 'resolved' });
    db.update('sessions', 'session_id', session.session_id, {
      stage: r.stage,
      node_id: cfg.nodes[0].id,
      level: 0,
      title: cfg.name + '导学',
    });
    session.stage = r.stage;
    session.node_id = cfg.nodes[0].id;
    session.level = 0;
    session.event_id = newEventFor(session, cfg.nodes[0].id);
  }

  const run = noProgressRun(session.session_id, session.event_id);
  const node = stages.nodeOf(session.stage, session.node_id);
  const cfg = stages.get(session.stage);
  const injectionKind = detectInjection(text);

  // 累积拼凑检测（9.2 用例 5）：同一求助事件内「直接要成品」次数 ≥3 → 转人工
  const askAttempts = db.count(
    `messages`,
    `session_id=? AND role='student' AND (${[
      "content LIKE '%直接给%'", "content LIKE '%帮我写%'", "content LIKE '%给个例子%'",
      "content LIKE '%完整%'", "content LIKE '%答案%'", "content LIKE '%成品%'",
    ].join(' OR ')})`,
    [session.session_id]
  );
  const repeatedAsk = injectionKind === 'ask_answer' && askAttempts >= 3;

  // 6 草稿生成
  const ctx = {
    stage: session.stage,
    nodeId: session.node_id,
    node,
    stageCfg: cfg,
    level: session.level || 0,
    capLevel: r.capLevel,
    unlockedLevel: r.unlockedLevel,
    text,
    intent: injectionKind ? 'injection' : r.intent,
    injectionKind,
    repeatedAsk,
    emotion: r.emotion,
    profile: r.profile,
    noProgressRun: run,
    explicitStuck: false,
    attachments,
  };

  let draft;
  let engine = 'rule';
  let modelVer = 'rule-engine-v1';
  let promptVer = null;
  /** 本轮模型调用的可观测信息：用于当面/"这条回复到底谁生成的"判定 */
  let llmDiag = { called: false, latencyMs: 0, cached: false, fallback: false, error: null };

  // 规则骨架先行：节点推进、层级、草稿抽取、制度性话术一律由确定性逻辑决定。
  // 模型的职责只限于「把这句话说得更好」，不决定流程走向——否则模型一旦漏返回
  // advance / extracted，学生就会卡死在第一个节点，层级留痕与 OBE 统计也会失真。
  draft = normalizeDraft(tutor.generateRule(ctx), ctx);

  // 对输出格式敏感或涉及合规的场景不上模型：概念讲解（走知识图谱）、报错诊断、
  // 产出物评审、越界请求、重复索要答案——这些必须保持可预期、可复現。
  const RULE_ONLY_INTENTS = ['concept', 'diagnose', 'review'];
  const useLlm = llm.isEnabled() && !injectionKind && !RULE_ONLY_INTENTS.includes(r.intent);

  if (useLlm) {
    const rendered = promptsLib.render('tutor', {
      stage: cfg.name,
      sprint_no: session.sprint_no,
      level: r.profile.baseLevel,
      prefer_style: r.profile.preferStyle,
      turn_count: run + 1,
      current_level: ctx.level,
      cap_level: r.capLevel,
      recent_stuck: r.recent.map((x) => x.title).join('、') || '无',
      node_goal: node ? node.goal : cfg.goal,
    }, student.class_id);
    promptVer = rendered.ver;
    const out = await llm.generate({
      systemPrompt: rendered.text,
      userPrompt: `【学生本轮输入】\n${text}\n\n【输出要求】严格按 Schema 输出 JSON，层级不得超过 L${ctx.level}，也不得超过封顶 L${r.capLevel}。`,
      // 分级路由：强模型在本网关实测 20s+（易触发超时降级），只在「已解锁到 L3 以上、
      // 教师授权后的深度讲解」这类低频高质量场景使用；日常引导一律走轻量模型。
      tier: ctx.level >= 3 ? 'strong' : 'light',
      level: ctx.level,
      stage: session.stage,
      sessionId: session.session_id,
      studentId: student.student_id,
      ruleFallback: () => tutor.generateRule(ctx),
    });
    // 模型只覆盖话术文本；结构字段沿用规则骨架（随后仍由护栏审查这段文本）
    const cand = normalizeDraft(out.data, ctx);
    const modelText = String(cand.reply_text || '').trim();
    if (modelText) draft = { ...draft, reply_text: modelText };
    engine = out.engine;
    modelVer = out.model;
    llmDiag = {
      called: true,
      latencyMs: out.latencyMs || 0,
      cached: !!out.cached,
      fallback: !!out.fallback,
      error: out.error || null,
    };
  }

  // 6b 结构性合规兜底：最终按「规则判定的层级」补齐免责声明。
  // 层级由规则骨架决定（如 L3），而模型可能按自己的 level_used=0 生成文本，
  // 因此声明必须在合并后、按最终层级再兜一次底。
  draft.reply_text = tutor.ensureDisclaimer(draft.reply_text, draft.level_used);

  // 6c 工具层接入（M2 / FR-104 ④）：编码、测试阶段贴代码块时自动跑静态检查，
  // 只附「问题清单 + 规范条目」摘要，不附修复代码。
  if ((session.stage === 'coding' || session.stage === 'testing') && !injectionKind) {
    const codeBlock = extractCodeBlock(text);
    if (codeBlock && codeBlock.lines >= 3) {
      try {
        const sc = staticCheck.run(codeBlock.code, { language: 'js' });
        if (sc.issues.length) {
          const top = sc.issues.slice(0, 5);
          draft.reply_text +=
            `\n\n── 工具检查（静态检查）──\n` +
            top.map((i) => `· 第 ${i.line} 行【${i.name}】${i.detail || i.excerpt}`).join('\n') +
            (sc.issues.length > 5 ? `\n· …共 ${sc.issues.length} 处，完整清单在「工具箱」里看` : '') +
            `\n清单和规范条目我给你，改的人必须是你（FR-104 红线）。先从第一处 error 级改起。`;
        } else {
          draft.reply_text += `\n\n── 工具检查（静态检查）──\n这份代码块没扫出规范问题。接着说你的卡点，我们继续拆。`;
        }
        staticCheck.logRun({
          studentId: student.student_id,
          groupId: student.group_id,
          sessionId: session.session_id,
          ok: sc.summary.bySeverity.error === 0,
          summary: { issues: sc.summary.totalIssues, bySeverity: sc.summary.bySeverity, trigger: 'pipeline-auto' },
        });
      } catch (_) {
        /* 工具失败不阻塞导学（2.3 约束 4：失败可降级） */
      }
    }
  }

  // 7 护栏校验
  const g = await guardrail.inspect({
    draft: draft.reply_text,
    level: draft.level_used === undefined ? ctx.level : draft.level_used,
    capLevel: r.capLevel,
    stage: session.stage,
    groupId: student.group_id,
    sessionId: session.session_id,
    studentId: student.student_id,
    engine,
  });

  // 8 规则层二次拦截（FR-108）
  const finalLevel = clampLevel(draft.level_used === undefined ? ctx.level : draft.level_used);
  const rl = redline.check(g.text, { level: Math.min(finalLevel, r.capLevel), stage: session.stage });

  let finalText = rl.blocked ? rl.text : g.text;
  let guardResult = g.result;
  if (rl.blocked) guardResult = 'downgrade';

  // 9 投递与留痕
  saveMessage(session.session_id, 'agent', finalText, {
    level: finalLevel,
    intent: draft.intent,
    engine,
    promptVer,
    modelVer,
    guard: guardResult,
  });

  // 产出物草稿：节点推进时合并抽取结果，供学生端实时卡片与阶段完成归档使用
  if (draft.advance && text) {
    const cur = jparse(session.draft, {});
    const next = { ...cur, ...(draft.extracted || {}) };
    if (node && node.field && !draft.extracted[node.field]) next[node.field] = String(text).slice(0, 400);
    db.update('sessions', 'session_id', session.session_id, { draft: JSON.stringify(next) });
  }

  // 更新层级与事件
  const nextLevel = draft.advance ? 0 : finalLevel;
  const patch = {
    level: nextLevel,
    last_at: now(),
    cap_level: r.capLevel,
  };
  if (draft.advance && draft.advance.to === '__done__') {
    patch.node_id = '__done__';
  } else if (draft.advance && draft.advance.to) {
    patch.node_id = draft.advance.to;
  }
  db.update('sessions', 'session_id', session.session_id, patch);

  // 事件推进
  if (session.event_id) {
    const ev = db.get('SELECT * FROM help_events WHERE event_id=?', [session.event_id]);
    if (ev) {
      const tags = [...new Set([...jparse(ev.knowledge_tags, []), ...(draft.knowledge_tags || [])])];
      if (draft.advance) {
        // 节点推进 → 本卡点解决，关闭事件，开新事件（层级归零）
        closeEvent(ev.event_id, {
          status: 'resolved',
          maxLevel: ev.max_level || 0,
          turns: (ev.turn_count || 0) + 1,
          tags,
        });
        if (draft.advance.to !== '__done__') {
          patch.event_id = newEventFor(session, draft.advance.to);
          db.update('sessions', 'session_id', session.session_id, { event_id: patch.event_id });
        } else {
          db.update('sessions', 'session_id', session.session_id, { event_id: null });
          writeArtifact(student, session, cfg);
        }
      } else {
        db.update('help_events', 'event_id', ev.event_id, {
          max_level: Math.max(ev.max_level || 0, finalLevel),
          turn_count: (ev.turn_count || 0) + 1,
          knowledge_tags: JSON.stringify(tags),
        });
      }
    }
  }

  // 10 闭环 / 情绪 / 预警
  if (r.emotion === 'frustrated') profile.bumpEmotion(student.student_id);
  if (r.emotion === 'crisis') {
    alerts.createAlert({
      targetType: 'student',
      targetId: student.student_id,
      ruleId: 'crisis',
      reason: '学生表达中出现极端表述，已建议转人工处理',
      suggest: '立即联系该学生，按学校心理危机干预流程处理',
    });
  }

  return {
    session: db.get('SELECT * FROM sessions WHERE session_id=?', [session.session_id]),
    reply: {
      text: finalText,
      level: finalLevel,
      levelName: ['L0 提示反问', 'L1 方向指引', 'L2 步骤拆解', 'L3 局部示例', 'L4 完整讲解'][finalLevel],
      intent: draft.intent,
      nextAction: draft.next_action,
      knowledgeTags: draft.knowledge_tags || [],
      stageComplete: !!draft.stageComplete,
      needUnlock: !!draft.need_unlock || (finalLevel >= r.capLevel && draft.is_stuck_point),
      needHuman: !!draft.need_human || g.needHuman,
    },
    context: {
      stage: session.stage,
      stageName: cfg ? cfg.name : '',
      nodeId: session.node_id,
      nodeTitle: node ? node.title : '',
      progress: stages.progressOf(session.stage, session.node_id),
      capLevel: r.capLevel,
      capSource: r.capSource,
      resumed,
      guard: guardResult,
      engine,
      modelVer,
      latencyMs: Date.now() - t0,
      // 来源可观测：一条回复到底是不是大模型生成的，直接看这里。
      // 三种取值含义：
      //   engine='llm'  → 话术文本由模型生成（结构字段仍由规则骨架决定）
      //   engine='rule' + called=true + fallback=true → 调了模型但失败/超时，已降级
      //   engine='rule' + called=false → 本轮压根没调模型（未启用 / 越界请求 / 规则专属意图）
      source: {
        engine,
        model: modelVer,
        called: llmDiag.called,
        cached: llmDiag.cached,
        fallback: llmDiag.fallback,
        modelLatencyMs: llmDiag.latencyMs,
        modelError: llmDiag.error,
        emptyText: llmDiag.called && engine === 'llm' && !String(draft.reply_text || '').trim(),
        intent: r.intent,
        ruleOnly: RULE_ONLY_INTENTS.includes(r.intent),
        llmEnabled: llm.isEnabled(),
      },
    },
  };
}

/** 「我还是卡住了」显式升级 */
async function handleUpgrade({ student, sessionId }) {
  const session = db.get('SELECT * FROM sessions WHERE session_id=?', [sessionId]);
  if (!session) throw Object.assign(new Error('会话不存在'), { status: 404 });

  const group = db.get('SELECT * FROM groups WHERE group_id=?', [student.group_id]);
  const r = orchestrator.route({ student, text: '', session, group });
  const node = stages.nodeOf(session.stage, session.node_id);
  const cfg = stages.get(session.stage);
  const capLevel = r.capLevel;

  const cur = clampLevel(session.level || 0);
  if (cur >= capLevel) {
    // 已封顶 → 生成解锁申请（FR-506）
    const reqId = createUnlockRequest({
      student,
      eventId: session.event_id,
      targetLevel: Math.min(4, cur + 1),
      reason: `在「${node ? node.title : cfg.name}」连续卡住，已达本轮封顶 L${capLevel}`,
      trace: { levelTrail: [cur], capLevel },
    });
    const sysMsg =
      `已达本轮介入上限 L${capLevel}。\n按规则我不能自己往上走——我已经把解锁申请发给老师了，` +
      `老师批准后我会继续；你也可以直接找老师或助教练一遍。`;
    saveMessage(sessionId, 'system', sysMsg, { level: cur });
    alerts.createAlert({
      targetType: 'student',
      targetId: student.student_id,
      ruleId: 'unlock_pending',
      reason: `申请解锁至 L${Math.min(4, cur + 1)}（${node ? node.title : cfg.name}）`,
      suggest: '在教师端「解锁审批」中处理',
    });
    return {
      text: sysMsg,
      level: cur,
      capped: true,
      unlockRequestId: reqId,
      needUnlock: true,
    };
  }

  const next = cur + 1;
  let body = node ? node.prompts[next] : null;
  if (!body) body = node ? node.prompts[1] : '这一步我们拆开看：你先说说卡在哪？';

  const g = await guardrail.inspect({
    draft: body,
    level: next,
    capLevel,
    stage: session.stage,
    groupId: student.group_id,
    sessionId,
    studentId: student.student_id,
    engine: 'rule',
  });
  const rl = redline.check(g.text, { level: next, stage: session.stage });
  const finalText = rl.blocked ? rl.text : g.text;

  saveMessage(sessionId, 'system', `求助升级 → L${next} ${['提示反问', '方向指引', '步骤拆解', '局部示例', '完整讲解'][next]}`, { level: next });
  saveMessage(sessionId, 'agent', finalText, { level: next, intent: 'scaffold', engine: 'rule', guard: g.result });
  db.update('sessions', 'session_id', sessionId, { level: next, last_at: now() });
  if (session.event_id) {
    const ev = db.get('SELECT * FROM help_events WHERE event_id=?', [session.event_id]);
    if (ev) {
      db.update('help_events', 'event_id', ev.event_id, {
        max_level: Math.max(ev.max_level || 0, next),
        upgrade_count: (ev.upgrade_count || 0) + 1,
        knowledge_tags: JSON.stringify(knowledge.tag(node ? node.title : '', 2).concat(jparse(ev.knowledge_tags, []))),
      });
    }
  }
  return { text: finalText, level: next, capped: false, needUnlock: false };
}

// ---------------- 产出物与解锁 ----------------

function writeArtifact(student, session, cfg) {
  const draft = jparse(session.draft, {});
  const content = {};
  for (const f of cfg.artifactFields) {
    content[f.key] = draft[f.key] || '';
  }
  // 标题兜底：用痛点或首条回答
  if (!content.title) {
    const first = db.get(
      `SELECT content FROM messages WHERE session_id=? AND role='student' ORDER BY created_at LIMIT 1`,
      [session.session_id]
    );
    const base = draft.pain || (first ? first.content : '') || '';
    content.title = String(base).slice(0, 20);
  }
  const prev = db.get(
    'SELECT * FROM artifacts WHERE group_id=? AND stage=? ORDER BY version DESC LIMIT 1',
    [student.group_id, cfg.key]
  );
  const id = uid('art');
  db.insert('artifacts', {
    artifact_id: id,
    group_id: student.group_id,
    student_id: student.student_id,
    stage: cfg.key,
    type: cfg.artifactType,
    content: JSON.stringify(content),
    version: prev ? (prev.version || 1) + 1 : 1,
    prev_version_id: prev ? prev.artifact_id : null,
    knowledge_tags: JSON.stringify(cfg.knowledgeTags || []),
    created_at: now(),
  });
  return id;
}

function createUnlockRequest({ student, eventId, targetLevel, reason, trace }) {
  const id = uid('req');
  db.insert('unlock_requests', {
    req_id: id,
    student_id: student.student_id,
    event_id: eventId || null,
    target_level: clampLevel(targetLevel),
    reason: reason || '',
    trace: JSON.stringify(trace || {}),
    decision: 'pending',
    created_at: now(),
  });
  return id;
}

module.exports = {
  handleMessage, handleUpgrade, ensureSession, saveMessage, closeEvent,
  createUnlockRequest, writeArtifact, noProgressRun,
};
