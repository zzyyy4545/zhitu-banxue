'use strict';
/**
 * 调度 Agent（4.4）
 * 职责：意图识别、阶段判定、工具选择、层级决策
 * 失败处理：降级为通用导学话术
 */
const db = require('../db');
const stages = require('./stages');
const policy = require('./policy');
const { detectInjection, detectEmotion, jparse, withinHours } = require('./util');

const INTENT_RULES = [
  { intent: 'concept', re: /(什么是|什么叫|怎么理解|解释|讲一下|讲讲|区别|概念|意思是|啥是)/ },
  { intent: 'diagnose', re: /(报错|错误|异常|exception|error|失败|不对|bug|Bug|跑不起来|编译|堆栈|NullPointer|空指针)/ },
  { intent: 'review', re: /(帮我看看|看一下我|这样写对吗|检查一下|评审|评估|INVEST|打分|评价一下)/ },
  { intent: 'switch_stage', re: /(进入|切换到|开始|转到).{0,6}(需求|架构|编码|测试|评审|答辩|复盘)/ },
  { intent: 'emotion', re: /(算了|不想做了|太难了|放弃了|做不出来|没意义|摆烂)/ },
  { intent: 'greeting', re: /^(你好|hi|hello|在吗|嗨|早上好|晚上好)/i },
];

const STAGE_KEYWORDS = [
  { key: 'requirements', re: /需求|故事卡|用户故事|验收标准|INVEST/ },
  { key: 'architecture', re: /架构|设计|方案|选型|UML|设计模式|模块/ },
  { key: 'coding', re: /编码|代码|实现|函数|类|Git|提交|分支|命名|规范/ },
  { key: 'testing', re: /测试|用例|覆盖率|缺陷|bug|Bug|等价类|边界/ },
  { key: 'review', re: /评审|答辩|演示|汇报|PPT|预演/ },
  { key: 'retro', re: /复盘|回顾|总结|改进|补学/ },
];

function classifyIntent(text) {
  const t = String(text || '');
  for (const r of INTENT_RULES) if (r.re.test(t)) return r.intent;
  return 'scaffold';
}

function resolveStage(text, currentStage) {
  const t = String(text || '');
  for (const s of STAGE_KEYWORDS) {
    if (s.re.test(t) && stages.get(s.key)) return { stage: s.key, switched: s.key !== currentStage };
  }
  return { stage: currentStage, switched: false };
}

/** 最近 3 次同类求助摘要（4.2 步骤 3） */
function recentStuck(studentId, stage, limit = 3) {
  const rows = db.all(
    `SELECT title, status, max_level, opened_at FROM help_events
     WHERE student_id=? ${stage ? 'AND stage=?' : ''}
     ORDER BY opened_at DESC LIMIT ?`,
    stage ? [studentId, stage, limit] : [studentId, limit]
  );
  return rows.map((r) => ({
    title: r.title,
    status: r.status,
    maxLevel: r.max_level,
    openedAt: r.opened_at,
  }));
}

/** 学生画像（FR-602） */
function profileOf(studentId) {
  const p = db.get('SELECT * FROM learner_profiles WHERE student_id=?', [studentId]);
  if (!p) {
    return { baseLevel: '初学', preferStyle: '类比', progress: {}, stuckTags: [], levelDistribution: {}, avgTurns: 0 };
  }
  return {
    baseLevel: p.base_level,
    preferStyle: p.prefer_style,
    progress: jparse(p.progress, {}),
    stuckTags: jparse(p.stuck_tags, []),
    levelDistribution: jparse(p.level_distribution, {}),
    avgTurns: p.avg_turns || 0,
    emotionSignals: p.emotion_signals || 0,
  };
}

/** 教师解锁授权（FR-506：仅当次任务当次生效，到期自动回落） */
function activeUnlock(studentId) {
  const r = db.get(
    `SELECT * FROM unlock_requests
     WHERE student_id=? AND decision='approved'
       AND (valid_until IS NULL OR valid_until >= ?)
     ORDER BY decided_at DESC LIMIT 1`,
    [studentId, new Date().toISOString()]
  );
  return r || null;
}

/**
 * 组装路由决策（4.2 步骤 2–5）
 */
function route({ student, text, session, group, attachments }) {
  const intent = detectInjection(text) ? 'injection' : classifyIntent(text);
  const emotion = detectEmotion(text);
  const { stage, switched } = resolveStage(text, session ? session.stage : 'requirements');

  const capRes = policy.resolveCap({
    classId: student.class_id,
    groupId: student.group_id,
    stage,
  });

  const unlock = activeUnlock(student.student_id);
  const lastEvent = db.get(
    `SELECT * FROM help_events WHERE student_id=? AND stage=? ORDER BY opened_at DESC LIMIT 1`,
    [student.student_id, stage]
  );
  const samePointWithin24h = !!(
    lastEvent && lastEvent.status === 'resolved' && withinHours(lastEvent.closed_at, 24)
  );

  return {
    intent,
    emotion,
    stage,
    stageSwitched: switched,
    capLevel: capRes.cap,
    capSource: capRes.source,
    unlockedLevel: unlock ? unlock.target_level : null,
    profile: profileOf(student.student_id),
    recent: recentStuck(student.student_id, stage),
    samePointWithin24h,
    lastMaxLevel: lastEvent ? lastEvent.max_level : 0,
    attachments: attachments || [],
  };
}

module.exports = { route, classifyIntent, resolveStage, recentStuck, profileOf, activeUnlock };
