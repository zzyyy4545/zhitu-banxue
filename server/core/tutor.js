'use strict';
/**
 * 导学 Agent（4.4）
 * 输入：路由决策 + 检索结果 + 层级约束
 * 输出：结构化回复 JSON（对齐说明书 8.2 Schema）
 *
 * 规则引擎为主（离线可用、行为确定、便于教学侧评审）；
 * 配置了模型 API 时走 LLM，失败自动回落规则引擎（2.3 约束 4：失败可降级）。
 */
const stages = require('./stages');
const knowledge = require('./knowledge');
const levelMachine = require('./levelMachine');
const { clampLevel } = require('./util');
const { ASK_EXAMPLE_RE } = require('./levelMachine');

// ---- 固定话术（红线相关，必须稳定输出）----
const JAILBREAK_REPLY =
  '这个设定我不接——我还是知途，还是这套规则：陪你想，不替你做。\n换个方式：你现在的卡点具体是哪一步？我们从那一步开始。';

const ASK_ANSWER_REPLY =
  '直接给你成品这一步，我做不到——交上去就不是你做的了。\n我能给到的是思路和脚手架；如果你确实需要更完整的讲解，可以提交解锁申请，由老师判断给不给、给到哪一层。';

/** 累积拼凑：多次诱导后（9.2 用例 5），第 3 次起提示转人工 */
const REPEATED_ASK_REPLY =
  '你已经连续三次想直接要成品了，我再往下说就等于替你做了。\n这一步建议转人工：找老师或助教当面过一遍，比在这儿绕快得多。\n如果你确实需要完整讲解，走解锁申请——由老师判断给不给。';

const CRISIS_REPLY =
  '你刚才说的话我接不住，也不该由我来接。\n我已经把这件事提醒给任课老师了，老师会联系你。你先别一个人扛——现在就去联系老师或者身边信任的人。';

const EMPATHY_PREFIX = '连着卡住确实磨人。先别急着赶进度，我们把这一步再砍小一点——\n';

// ---- FR-104 报错诊断思路链模板 ----
const DIAGNOSE_PATTERNS = [
  {
    re: /NullPointer|空指针|undefined is not|cannot read property/i,
    name: '空引用',
    causes: [
      '某个对象在使用前没被赋值（最常见是查询返回空、配置项没读到）',
      '集合或数组本身是 null，你对它调了方法',
      '调用方传进来的参数没做判空',
    ],
  },
  {
    re: /超时|timeout|timed out|太慢|卡住不动/i,
    name: '超时/性能',
    causes: [
      '循环里做了 I/O（查库、调接口），数据量一大就成倍放大',
      '查询没走索引，全表扫描',
      '存在死循环或递归没有终止条件',
    ],
  },
  {
    re: /编译|compilation|syntax|语法|找不到符号|cannot find symbol/i,
    name: '编译/语法',
    causes: [
      '拼写或大小写不一致（类名、方法名、包名）',
      '依赖没引进来，或版本不匹配',
      '类型不匹配（返回值与接收变量类型不一致）',
    ],
  },
  {
    re: /测试失败|断言|assert|expected|不通过/i,
    name: '测试失败',
    causes: [
      '期望值写错了——你以为的行为和实际实现不一致',
      '测试数据没清理，上一次的残留影响了这次',
      '被测逻辑确实有问题',
    ],
  },
  {
    re: /404|403|401|500|接口|请求失败|连接/i,
    name: '接口/网络',
    causes: [
      '路径或参数拼错了（尤其是路径变量与查询参数混用）',
      '权限或登录态没带上',
      '服务没起来，或端口/环境不对',
    ],
  },
];

function diagnoseChain(text) {
  const t = String(text || '');
  const hit = DIAGNOSE_PATTERNS.find((p) => p.re.test(t));
  const name = hit ? hit.name : '未分类';
  const causes = hit
    ? hit.causes
    : [
        '输入与预期不一致（传进来的值不是你以为的那个）',
        '执行顺序不对（依赖的东西还没准备好）',
        '环境差异（本地能跑，换个环境就不行）',
      ];
  const body =
    `先别急着改。按这个顺序来：\n` +
    `现象：${t.slice(0, 80) || '（你还没贴具体报错，先把报错原文或截图发我）'}\n\n` +
    `可能原因（按概率排序）：\n` +
    causes.map((c, i) => `${i + 1}. ${c}`).join('\n') +
    `\n\n先验证第 1 条：在出错位置的前一行，把关键变量的值打印出来（或打个断点看一眼），确认它到底是不是你以为的值。\n` +
    `做完告诉我看到的是什么，我再给下一步。`;
  return { name, body, knowledgeTags: hit ? ['缺陷定位'] : [] };
}

function lastSentence(text) {
  const parts = String(text || '').split('\n').filter((x) => x.trim());
  return parts.length ? parts[parts.length - 1] : '';
}

/**
 * 规则引擎生成（同步）
 * @param {object} c
 *   stage, nodeId, level, capLevel, text, intent, profile, node, stageCfg, unlockedLevel, noProgressRun, explicitStuck
 */
function generateRule(c) {
  const cfg = c.stageCfg || stages.get(c.stage);
  const node = c.node || stages.nodeOf(c.stage, c.nodeId);
  const base = {
    intent: c.intent || 'scaffold',
    stage: c.stage,
    knowledge_tags: [],
    is_stuck_point: false,
    blocked_by_cap: false,
    confidence: 0.9,
    need_human: false,
  };

  // ① 注入 / 绕过 —— 行为不变
  if (c.intent === 'injection') {
    const kind = c.injectionKind;
    let text;
    if (kind === 'jailbreak') {
      text = JAILBREAK_REPLY;
    } else if (c.repeatedAsk) {
      // 累积拼凑：同一卡点内第 3 次起转人工（9.2 用例 5）
      text = REPEATED_ASK_REPLY;
    } else {
      text = ASK_ANSWER_REPLY + (c.capped ? '\n（提示：本轮教师设定的封顶层是 L' + c.capLevel + '。）' : '');
    }
    return {
      ...base,
      reply_text: text,
      level_used: 0,
      next_action: c.repeatedAsk ? '联系老师或助教当面辅导' : '说出你具体卡在哪一步',
      intent: 'other',
      blocked_by_cap: !!c.capped,
      need_human: !!c.repeatedAsk,
    };
  }

  // ② 危机信号 → 转人工（FR-106 边界）
  if (c.emotion === 'crisis') {
    return {
      ...base,
      reply_text: CRISIS_REPLY,
      level_used: 0,
      intent: 'emotion',
      next_action: '联系任课教师或身边信任的人',
      need_human: true,
    };
  }

  // ③ 概念精讲（FR-103）
  if (c.intent === 'concept') {
    const q = String(c.text || '').replace(/(什么是|什么叫|怎么理解|解释|讲一下|讲讲|啥是)/g, '').trim();
    const ex = knowledge.explain(q, c.profile && c.profile.baseLevel);
    return {
      ...base,
      reply_text: ex.text,
      // 概念讲解是知识性输出、不是可提交成果，不占介入梯度，因此记为 L0；
      // 用 explain 标记单独区分，避免污染层级分布统计（论文「L0–L1 停留占比」口径）
      level_used: 0,
      explain: true,
      intent: 'concept',
      knowledge_tags: ex.knowledge_tags || [],
      next_action: '回答上面的自测问题',
      confidence: ex.found ? 0.9 : 0.4,
    };
  }

  // ④ 报错诊断（FR-104）
  if (c.intent === 'diagnose') {
    const d = diagnoseChain(c.text);
    return {
      ...base,
      reply_text: d.body,
      level_used: 2,
      intent: 'diagnose',
      knowledge_tags: d.knowledgeTags,
      is_stuck_point: true,
      next_action: '打印关键变量的值，把结果告诉我',
    };
  }

  // ⑤ 场景推进（默认）
  if (!cfg || !node) {
    return {
      ...base,
      reply_text: '这一段我还没配好导学剧本。先说说你现在卡在哪一步？',
      level_used: 0,
      next_action: '描述当前卡点',
    };
  }

  const text = String(c.text || '');
  const v = text ? stages.validate(node, text) : { ok: false, issues: [], branch: null, extracted: {} };
  // 学生明确要例子 → 不推进节点，按 4.1 规则升到 L3（示例必须是其他领域）
  const wantsExample = ASK_EXAMPLE_RE.test(text);

  // 有推进且不是要例子 → 前进下一节点，层级归零（新问题从 L0 起）
  if (v.ok && !wantsExample) {
    const next = stages.nextNode(c.stage, node.id);
    if (next) {
      const body = next.prompts[0];
      return {
        ...base,
        reply_text: `${acknowledge(node)}${body}`,
        level_used: 0,
        intent: 'scaffold',
        advance: { to: next.id, resetLevel: true },
        extracted: v.extracted,
        next_action: lastSentence(body),
      };
    }
    // 阶段最后一节点完成
    return {
      ...base,
      reply_text: cfg.closing,
      level_used: 0,
      intent: 'scaffold',
      advance: { to: '__done__', resetLevel: true },
      extracted: v.extracted,
      stageComplete: true,
      next_action: '把产出物拿去小组评审',
      knowledge_tags: cfg.knowledgeTags || [],
    };
  }

  // 未通过 / 要例子 → 诊断 + 按层级给脚手架
  const decision = levelMachine.decide({
    currentLevel: c.level,
    capLevel: c.capLevel,
    text,
    explicitStuck: c.explicitStuck,
    noProgressRun: c.noProgressRun,
    unlockedLevel: c.unlockedLevel,
    askExample: wantsExample,
  });

  const level = clampLevel(decision.level);
  let body = node.prompts[level];
  if (!body) body = node.prompts[1] || node.prompts[0];

  let prefix = '';
  if (wantsExample && level < 3) {
    prefix = decision.capped
      ? `例子我可以给，但按老师这轮设的封顶层（L${c.capLevel}），我现在只能给到方向。\n`
      : '';
  } else if (v.branch && v.branch === node.id) {
    prefix = `这里有个信号我要指出来：${v.issues[0]}。\n`;
  } else if (v.issues.length) {
    prefix = `${v.issues[0]}。\n`;
  }
  if (wantsExample && level >= 3) {
    prefix += '先给一个参照，但这不是你们的答案——答案还得你们自己填。\n';
  }
  if (c.emotion === 'frustrated') prefix = EMPATHY_PREFIX + prefix;

  return {
    ...base,
    reply_text: prefix + body,
    level_used: level,
    intent: 'scaffold',
    is_stuck_point: true,
    blocked_by_cap: decision.capped,
    need_unlock: decision.needUnlock && decision.capped,
    next_action: lastSentence(body),
    knowledge_tags: knowledge.tag(text, 2),
    decision,
  };
}

function acknowledge(node) {
  const map = {
    who: '好，主用户先锁定这一类。记住这个选择——它决定你故事里「以便」那半句。\n',
    pain: '这一步记下来，它就是你故事的动机。\n',
    story: '这句站得住。接下来看怎么算做完。\n',
    acceptance: '验收标准记下了。\n',
    constraint: '约束先定下来，后面所有取舍都拿它当尺子。\n',
    candidates: '候选有了，接下来比什么。\n',
    dimensions: '维度定好了。\n',
    tradeoff: '选择和代价都写清了。\n',
    patterns: '模式选型有了依据。\n',
    task: '第一个小任务定了。\n',
    boundary: '职责边界清楚了。\n',
    naming: '命名过了一遍。\n',
    sketch: '逻辑讲通了，可以动手。\n',
    commit: '提交信息可以了。\n',
    target: '测试目标明确了。\n',
    equivalence: '等价类分好了。\n',
    boundary_b: '边界值补上了。\n',
    exception: '异常分支覆盖了。\n',
    coverage: '覆盖率看懂了。\n',
    defect: '定位思路有了。\n',
    structure: '结构搭好了。\n',
    audience: '受众清楚了。\n',
    questions: '问答准备过了。\n',
    evidence: '证据齐了。\n',
    expression: '表达收紧了。\n',
    good: '这条记下来。\n',
    improve: '这一条是真问题。\n',
    root: '根因找到了。\n',
    action: '行动项定了。\n',
    study: '补学清单有了。\n',
  };
  return map[node.id] || '好，这一步过了。\n';
}

/** 打招呼 / 开场 */
function opening(cfg, student, group, sprintNo) {
  const ctxLine = `Sprint ${sprintNo || 1} · ${cfg.name} · 本轮封顶 L${cfg.__cap || 2}`;
  return {
    contextLine: ctxLine,
    text:
      `你好，我是知途。${cfg.opening}\n` +
      `当前：${group && group.project_name ? group.project_name + ' · ' : ''}${cfg.name}（Sprint ${sprintNo || 1}）。\n` +
      `这一轮的目标是：${cfg.goal}。`,
  };
}

/**
 * 归一化模型输出为内部草稿结构（8.2 Schema 强制校验）
 * 解析失败时按保守策略处理：降级为 L0 通用引导（说明书 8.2 开发提示）
 */
/**
 * L3 及以上（局部示例 / 完整讲解）必须声明「这不是你们的答案」。
 * 结构性合规由代码兜底，不依赖模型自觉——模型润色后很容易把这句声明丢掉。
 */
const DISCLAIMER_RE = /(不是你们的答案|不是你的答案|不是答案|不是标准答案|仅供参照)/;
const DISCLAIMER_TEXT = '这段只是参照，不是你们的答案——答案还得你们自己填。\n\n';

/** 按「最终层级」补齐免责声明：不依赖文本来源（规则或模型），也不依赖模型自觉 */
function ensureDisclaimer(text, level) {
  const t = String(text || '');
  if (!(level >= 3) || !t.trim() || DISCLAIMER_RE.test(t)) return t;
  return DISCLAIMER_TEXT + t;
}

function normalizeDraft(data, ctx) {
  const d = data && typeof data === 'object' ? data : {};
  const lvl = clampLevel(d.level_used === undefined ? (ctx.level || 0) : d.level_used);
  const cap = clampLevel(ctx.capLevel === undefined ? 4 : ctx.capLevel);
  const used = Math.min(lvl, cap);
  let text = typeof d.reply_text === 'string' && d.reply_text.trim()
    ? d.reply_text
    : (ctx.node ? ctx.node.prompts[0] : '这一步我先问一句：你具体卡在哪？');
  if (used >= 3 && !DISCLAIMER_RE.test(text)) text = ensureDisclaimer(text, used);
  return {
    reply_text: text,
    level_used: used,
    intent: d.intent || 'scaffold',
    stage: d.stage || ctx.stage,
    knowledge_tags: Array.isArray(d.knowledge_tags) ? d.knowledge_tags : [],
    is_stuck_point: !!d.is_stuck_point,
    next_action: d.next_action || '',
    blocked_by_cap: lvl > cap ? true : !!d.blocked_by_cap,
    confidence: typeof d.confidence === 'number' ? d.confidence : 0.6,
    need_human: !!d.need_human,
    // 流程推进相关字段必须透传：漏掉 advance 会导致节点永远停在原地，
    // 漏掉 extracted 会让产出物草稿抽不到内容（历史坑，勿删）
    advance: d.advance && typeof d.advance === 'object' ? d.advance : undefined,
    extracted: d.extracted && typeof d.extracted === 'object' ? d.extracted : {},
    stageComplete: !!d.stageComplete,
    need_unlock: !!d.need_unlock,
    explain: !!d.explain,
  };
}

module.exports = {
  generateRule, normalizeDraft, ensureDisclaimer, diagnoseChain, opening,
  JAILBREAK_REPLY, ASK_ANSWER_REPLY, CRISIS_REPLY,
};
