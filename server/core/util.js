'use strict';
/** 通用工具：ID、时间、JSON 安全解析、文本特征判定 */

const crypto = require('node:crypto');

function uid(prefix) {
  return prefix + '_' + crypto.randomBytes(6).toString('hex');
}

function now() {
  return new Date().toISOString();
}

function jparse(s, fallback) {
  if (s === null || s === undefined || s === '') return fallback;
  if (typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch (_) {
    return fallback;
  }
}

function jstring(v, fallback) {
  if (v === undefined || v === null) return fallback === undefined ? '[]' : fallback;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

/** 相差小时数（b - a） */
function hoursBetween(a, b) {
  if (!a) return Infinity;
  return (new Date(b).getTime() - new Date(a).getTime()) / 3600000;
}

function withinHours(iso, h) {
  if (!iso) return false;
  return hoursBetween(iso, now()) <= h;
}

function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

/** 判定学生这一轮回复是否「有推进」：含新信息才算推进（4.1 状态机跃迁条件） */
const NO_PROGRESS_RE = [
  /^(不知道|不会|不懂|没思路|想不出|没头绪|不晓得)[。!！.~\s]*$/,
  /^(嗯|哦|啊|好|好的|行|ok|OK|收到)[。!！.~\s]*$/,
  /^(还是不会|还是不懂|还是不知道|继续|然后呢|呢)[。!！?？~\s]*$/,
];

function hasProgress(text) {
  const t = String(text || '').trim();
  if (t.length < 2) return false;
  for (const re of NO_PROGRESS_RE) if (re.test(t)) return false;
  // 纯标点/空白
  if (/^[\s\p{P}\p{S}]+$/u.test(t)) return false;
  return true;
}

/** 挫败 / 放弃倾向信号（FR-106） */
const FRUSTRATION_RE = [
  /算了/, /不想做了/, /放弃了/, /做不出来/, /太难了/, /没意义/,
  /搞不定/, /烦死了/, /摆烂/, /躺平/, /不想弄/,
];
/** 极端信号：涉及自伤等，立即转人工（FR-106 边界） */
const CRISIS_RE = [
  /不想活/, /自杀/, /轻生/, /结束生命/, /活不下去/,
];

function detectEmotion(text) {
  const t = String(text || '');
  if (CRISIS_RE.some((re) => re.test(t))) return 'crisis';
  if (FRUSTRATION_RE.some((re) => re.test(t))) return 'frustrated';
  return 'normal';
}

/** 诱导直接要答案的探测（9.2 防代做专项 + FR-107） */
const ASK_ANSWER_RE = [
  /直接(给|把|写|告诉我|给我)/,
  /(帮|替)我(写|写一下|写完|做|做完|生成一?[份个])/,
  /把.*?(完整|全部).*?(写出来|给我)/,
  /答案[是给我]?/,
  /给我?一?[份个].*?(完整|成品|现成)/,
  /(直接|马上|立刻).{0,6}(代码|实现|答案|文档)/,
  /抄一?[份个]/,
  /给个?能(直接|马上)(交|提交|用)/,
];

/** 角色扮演 / 越狱式绕过（9.2 测试用例） */
const JAILBREAK_RE = [
  /假设?你是.{0,10}(无限|无限制|没有限制|不受限制)/,
  /忽略(之前|上面|所有)(的)?(规则|指令|限制)/,
  /忽略以上/,
  /(开发者模式|developer mode|DAN|越狱)/i,
  /忘记(你|之前)(的)?(身份|设定|规则)/,
  /你现在是.{0,8}(普通|自由)(AI|模型|助手)/,
  /不要(再)?遵守/,
  /绕过(护栏|限制|规则)/,
];

function detectInjection(text) {
  const t = String(text || '');
  if (JAILBREAK_RE.some((re) => re.test(t))) return 'jailbreak';
  if (ASK_ANSWER_RE.some((re) => re.test(t))) return 'ask_answer';
  return null;
}

/** 统计代码块行数（用于 FR-108 规则：完整代码块 > 15 行） */
function maxCodeBlockLines(text) {
  const t = String(text || '');
  const blocks = t.match(/```[\s\S]*?```/g) || [];
  let max = 0;
  for (const b of blocks) {
    const lines = b.replace(/```[\w-]*/g, '').split('\n').filter((l) => l.trim()).length;
    if (lines > max) max = lines;
  }
  if (!blocks.length) {
    // 无围栏时，检测缩进密集的代码段
    const lines = t.split('\n');
    let run = 0;
    for (const l of lines) {
      if (/^(\s{2,}|\t)(if|for|while|public|private|class|function|def|return|const|let|var|void|import)\b/.test(l) ||
          /[{}();]\s*$/.test(l.trim()) && l.trim().length > 3) {
        run++;
        if (run > max) max = run;
      } else run = 0;
    }
  }
  return max;
}

function clampLevel(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(4, Math.round(v)));
}

module.exports = {
  uid, now, jparse, jstring, hoursBetween, withinHours, dayKey,
  hasProgress, detectEmotion, detectInjection, maxCodeBlockLines, clampLevel,
  FRUSTRATION_RE, CRISIS_RE, ASK_ANSWER_RE, JAILBREAK_RE,
};
