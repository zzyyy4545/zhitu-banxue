'use strict';
/**
 * FR-102 / 4.1 导学介入梯度状态机
 *
 * 层级：L0 提示反问 / L1 方向指引 / L2 步骤拆解 / L3 局部示例 / L4 完整讲解
 *
 * 跃迁规则（4.1 表）：
 *   L0→L1  学生点击「我还是卡住了」；或连续 2 轮回复未推进
 *   L1→L2  再次卡住；或同一卡点第 2 次求助
 *   L2→L3  再次卡住；或学生明确「给个例子」
 *   L3→L4  再次卡住；或教师已授权解锁
 *   任意    目标层级 > 封顶层 → 停在封顶层 + 生成解锁申请
 *
 * 重置：新问题 / 新阶段 / 新任务 → 归零回 L0
 * 衰减：同一卡点解决后 24h 内再度求助 → 从上次层级 -1 起步
 *
 * 【易错点】学生说「直接给我答案」不是解锁条件，须走审批（FR-506）。
 */
const { clampLevel, hasProgress } = require('./util');

const LEVEL_NAMES = ['L0 提示反问', 'L1 方向指引', 'L2 步骤拆解', 'L3 局部示例', 'L4 完整讲解'];
const LEVEL_BRIEF = ['提示反问', '方向指引', '步骤拆解', '局部示例', '完整讲解'];

/** 学生明确要例子 —— 触发 L2→L3 的额外条件 */
const ASK_EXAMPLE_RE = /(给(我)?(一)?个?(例子|示例|样例|示范))|(举个例子)|(参考(一下|案例))|(有没有例子)/;

/**
 * 判定本轮层级应如何变化
 * @param {object} ctx
 *   currentLevel  number  当前层级
 *   capLevel      number  封顶层（教师设定，1-4）
 *   explicitStuck boolean 学生点击了「我还是卡住了」
 *   text          string  学生本轮输入
 *   noProgressRun number  连续未推进轮次（由调用方累计）
 *   askExample    boolean 学生明确要例子（可外部覆盖）
 *   unlockedLevel number|null 教师已授权解锁到的层级
 * @returns {{level, capped, needUnlock, reason, upgraded}}
 */
function decide(ctx) {
  const cur = clampLevel(ctx.currentLevel || 0);
  const cap = clampLevel(ctx.capLevel === undefined ? 4 : ctx.capLevel);
  const text = String(ctx.text || '');
  const explicitStuck = !!ctx.explicitStuck;
  const noProgressRun = Number(ctx.noProgressRun || 0);
  const askExample = ctx.askExample === undefined ? ASK_EXAMPLE_RE.test(text) : !!ctx.askExample;

  // 「直接给我答案」不是解锁条件：返回特殊标记，由上层给出固定话术
  const wantsAnswerOnly = /直接(给|把|写)|给我答案|帮我写完|直接要答案/.test(text) && !explicitStuck;

  let target = cur;
  let reason = 'stay';

  if (explicitStuck || noProgressRun >= 2) {
    target = cur + 1;
    reason = explicitStuck ? 'explicit_stuck' : 'no_progress_2';
  } else if (askExample && cur < 3) {
    // 学生明确要例子 → 至少到 L3（仍需受封顶约束，且 L3 示例须是其他领域）
    target = Math.max(cur + 1, 3);
    reason = 'ask_example';
  } else if (hasProgress(text) && cur > 0) {
    // 有推进：不自动降级，但也不升级（层级单调不降，避免抖动）
    reason = 'progressed';
  }

  // 教师已授权解锁：允许直接到达授权层级（FR-506，仅当次任务当次生效）
  if (ctx.unlockedLevel !== null && ctx.unlockedLevel !== undefined) {
    const ul = clampLevel(ctx.unlockedLevel);
    if (ul > target) {
      target = ul;
      reason = 'teacher_unlocked';
    }
  }

  target = clampLevel(target);

  // 封顶拦截
  let capped = false;
  let needUnlock = false;
  if (target > cap) {
    // 教师解锁可越过封顶（解锁本身就是教师授权的提级）
    if (ctx.unlockedLevel !== null && ctx.unlockedLevel !== undefined && clampLevel(ctx.unlockedLevel) > cap) {
      target = clampLevel(ctx.unlockedLevel);
      reason = 'teacher_unlocked_override';
    } else {
      target = cap;
      capped = true;
      needUnlock = true;
      reason = 'capped';
    }
  }

  return {
    level: target,
    capped,
    needUnlock,
    reason,
    upgraded: target > cur,
    wantsAnswerOnly,
    levelName: LEVEL_NAMES[target],
  };
}

/**
 * 新求助事件的起始层级：
 * - 新问题/新阶段/新任务 → 0
 * - 同一卡点 24h 内再度求助 → 上次层级 -1（衰减，防连续走高）
 */
function startLevelFor({ samePointWithin24h, lastMaxLevel, newStage, newTask }) {
  if (newStage || newTask) return 0;
  if (samePointWithin24h) return Math.max(0, clampLevel(lastMaxLevel) - 1);
  return 0;
}

module.exports = {
  decide,
  startLevelFor,
  LEVEL_NAMES,
  LEVEL_BRIEF,
  ASK_EXAMPLE_RE,
  clampLevel,
};
