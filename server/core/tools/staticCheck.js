'use strict';
/**
 * M2 工具层 · 静态检查（FR-104 ④ / FR-203）
 *
 * 红线（FR-104）：只输出「问题清单 + 规范条目」，绝不输出修复后的完整代码。
 * 规则面向 JS / Java（课程主力语言），纯规则实现，零第三方依赖。
 */
const db = require('../../db');
const { uid, now } = require('../util');

/** 内置规则库（可按教师需求扩展；保持只报问题、不带修复代码） */
const RULES = [
  {
    code: 'SC_CONSOLE',
    name: '调试残留',
    severity: 'error',
    langs: ['js'],
    re: /\b(console\.log|debugger)\b/,
    guidance: '发布前应移除调试输出：console.log 留在生产代码里会暴露内部数据，也会拖慢执行。规范条目：《编码规范》调试代码不得入库。',
  },
  {
    code: 'SC_NAMING',
    name: '无信息量命名',
    severity: 'warn',
    langs: ['js', 'java'],
    re: /\b(?:var|let|const|function|def|public|private|protected)\s+(temp\d?|tmp\d?|data\d?|info\d?|flag\d?|obj\d?|a\d|b\d|x\d|doIt|getData|processData|handleData|util\d?|manager)\b/,
    guidance: '名字应承载意图：看到名字就知道它是什么。data/info/flag/temp 这类「什么都能装」的词是典型扣分点。规范条目：《编码规范》命名须能自解释。',
  },
  {
    code: 'SC_PINYIN',
    name: '拼音命名',
    severity: 'warn',
    langs: ['js', 'java'],
    re: /\b(?:var|let|const|function|public|private)\s+(shuju|chuli|jisuan|mima|liebiao|hanshu|denglu|zhuce|xiugai|chaxun)\w*\b/,
    guidance: '拼音命名三个月后连你自己都读不懂。规范条目：《编码规范》标识符使用英文，专有名词除外。',
  },
  {
    code: 'SC_LONG_LINE',
    name: '超长行',
    severity: 'info',
    langs: ['js', 'java'],
    perLine: true,
    threshold: 120,
    guidance: '一行超过 120 字符说明这段逻辑值得拆行或提取。规范条目：《编码规范》单行不超过 120 字符。',
  },
  {
    code: 'SC_LONG_FN',
    name: '超长函数',
    severity: 'warn',
    langs: ['js', 'java'],
    block: 'function',
    threshold: 60,
    guidance: '函数超过 60 行，大概率承担了多个职责——试着按「一个函数只做一件事」拆开。规范条目：《编码规范》函数体 ≤ 60 行。',
  },
  {
    code: 'SC_DEEP_NEST',
    name: '嵌套过深',
    severity: 'warn',
    langs: ['js', 'java'],
    perLine: true,
    depth: 5,
    guidance: '嵌套超过 4 层基本没法测。卫语句（提前 return）、提取方法都能把它压平。规范条目：《编码规范》嵌套 ≤ 4 层。',
  },
  {
    code: 'SC_TODO',
    name: 'TODO/FIXME 残留',
    severity: 'info',
    langs: ['js', 'java'],
    re: /\b(TODO|FIXME|XXX|HACK)\b/,
    guidance: 'TODO 不是免检通行证：留一条就要写清谁、什么时候处理。规范条目：《编码规范》TODO 必须带责任人与期限。',
  },
  {
    code: 'SC_LOOSE_EQ',
    name: '松散相等比较',
    severity: 'warn',
    langs: ['js'],
    re: /(?<![=!<>])(==|!=)(?!=)/,
    guidance: '== 会做隐式类型转换（"1" == 1 为 true），是难查的坑。除非明确依赖转换语义，一律用 === / !==。规范条目：《编码规范》比较使用严格相等。',
  },
  {
    code: 'SC_VAR',
    name: 'var 声明',
    severity: 'warn',
    langs: ['js'],
    re: /\bvar\s+[A-Za-z_$]/,
    guidance: 'var 是函数作用域且允许重复声明，容易在循环闭包里踩坑。用 const 表达不变、let 表达可变。规范条目：《编码规范》禁用 var。',
  },
  {
    code: 'SC_EMPTY_CATCH',
    name: '空 catch 吞异常',
    severity: 'error',
    langs: ['js', 'java'],
    re: /catch\s*(\([^)]*\))?\s*\{\s*\}/,
    guidance: '空 catch 把错误无声吞掉，出了问题连日志都没有。至少记录错误并说明为什么可以忽略。规范条目：《编码规范》异常必须被处理或记录。',
  },
  {
    code: 'SC_EVAL',
    name: 'eval / 动态代码执行',
    severity: 'error',
    langs: ['js', 'java'],
    re: /\beval\s*\(|new\s+Function\s*\(/,
    guidance: 'eval 会执行任意字符串代码，是注入攻击入口，也摧毁静态分析。改用对象映射或显式分支。规范条目：《编码规范》禁止动态执行字符串代码。',
  },
  {
    code: 'SC_ALERT',
    name: 'alert 调试弹窗',
    severity: 'error',
    langs: ['js'],
    re: /(?<![.\w])\balert\s*\(/,
    guidance: 'alert 会阻塞页面且不可批量关闭，只适合临时调试。规范条目：《编码规范》调试弹窗不得入库（同 console.log）。',
  },
  {
    code: 'SC_MAGIC_NUM',
    name: '条件中的魔法数字',
    severity: 'info',
    langs: ['js', 'java'],
    magic: true,
    guidance: 'if (x > 37.5) 里的 37.5 没人知道是什么。提取成具名常量，让条件自己讲清楚业务含义。规范条目：《编码规范》阈值类数字必须具名化。',
  },
  {
    code: 'SC_LONG_PARAMS',
    name: '参数列表过长',
    severity: 'warn',
    langs: ['js', 'java'],
    params: 4,
    guidance: '参数超过 4 个，调用方很难用对——考虑收拢成对象参数，或拆分职责。规范条目：《编码规范》函数参数 ≤ 4 个。',
  },
  {
    code: 'SC_DUP_FN',
    name: '重复函数名',
    severity: 'error',
    langs: ['js', 'java'],
    dup: true,
    guidance: '同名函数后者会覆盖前者，这类 bug 在运行时才爆发。规范条目：《编码规范》标识符不得重复定义。',
  },
];

const LANG_OF_EXT = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', java: 'java',
};

function detectLanguage(filename, code) {
  if (filename) {
    const ext = String(filename).split('.').pop().toLowerCase();
    if (LANG_OF_EXT[ext]) return LANG_OF_EXT[ext];
  }
  if (/\b(public\s+class|System\.out\.print|private\s+\w+\s+\w+\()/m.test(String(code || ''))) return 'java';
  return 'js';
}

/** 逐行规则（超长行 / 嵌套深度） */
function lineIssues(code, lang, rules) {
  const issues = [];
  const lines = String(code).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const rule of rules) {
      if (rule.langs.includes(lang) && rule.perLine && rule.threshold && line.length > rule.threshold) {
        issues.push(mkIssue(rule, i + 1, line, `本行 ${line.length} 字符 > ${rule.threshold}`, 1));
      }
    }
    // 嵌套深度：按缩进层级估算（2/4 空格或 Tab 均可）
    const indent = line.match(/^[\t ]*/)[0];
    const level = indent.includes('\t') ? indent.length : Math.floor(indent.length / 2);
    const deepRule = rules.find((r) => r.code === 'SC_DEEP_NEST' && r.langs.includes(lang));
    if (deepRule && level >= deepRule.depth && line.trim()) {
      issues.push(mkIssue(deepRule, i + 1, line, `嵌套约 ${level} 层 > ${deepRule.depth - 1} 层`, indent.length + 1));
    }
  });
  return issues;
}

/** 正则类规则（每行首处命中，同类问题每文件最多报 5 处防刷屏） */
function regexIssues(code, lang, rules) {
  const issues = [];
  const lines = String(code).split(/\r?\n/);
  for (const rule of rules) {
    if (!rule.re || !rule.langs.includes(lang)) continue;
    let hits = 0;
    lines.forEach((line, i) => {
      if (hits >= 5) return;
      const m = rule.re.exec(line);
      if (m) {
        issues.push(mkIssue(rule, i + 1, line, `命中「${m[0].slice(0, 30)}」`, (m.index || 0) + 1));
        hits++;
      }
    });
  }
  return issues;
}

const MAGIC_OK = new Set(['-1']);

/** 魔法数字（条件中的裸数字阈值）：
 *  惯用值不报——0-9 的小整数（下标/计数）、整十整百（10/20/…/100/1000）、-1；
 *  报「像业务阈值」的：小数（37.5）与非整十的两位以上整数（37、85）。 */
function looksLikeMagic(numStr) {
  if (MAGIC_OK.has(numStr)) return false;
  const n = Number(numStr);
  if (Number.isInteger(n) && Math.abs(n) >= 0 && Math.abs(n) <= 9) return false;
  if (Number.isInteger(n) && Math.abs(n) % 10 === 0) return false;
  return true;
}
function magicNumIssues(code, lang, rules) {
  const rule = rules.find((r) => r.code === 'SC_MAGIC_NUM' && r.langs.includes(lang));
  if (!rule) return [];
  const issues = [];
  const lines = String(code).split(/\r?\n/);
  let hits = 0;
  lines.forEach((line, i) => {
    if (hits >= 5) return;
    const re = /([<>]=?|===?|!==?)\s*(-?\d+(?:\.\d+)?)/g;
    let m;
    while ((m = re.exec(line))) {
      if (!looksLikeMagic(m[2])) continue;
      issues.push(mkIssue(rule, i + 1, line, `条件中的数字 ${m[2]} 无具名常量`, m.index + 1));
      hits++;
      if (hits >= 5) return;
    }
  });
  return issues;
}

/** 参数列表过长（函数头行内参数 > 4 个） */
function paramsIssues(code, lang, rules) {
  const rule = rules.find((r) => r.code === 'SC_LONG_PARAMS' && r.langs.includes(lang));
  if (!rule) return [];
  const issues = [];
  const lines = String(code).split(/\r?\n/);
  const HEADER = lang === 'java'
    ? /(?:public|private|protected|static)\s+[\w<>\[\]]+\s+(\w+)\s*\(([^)]*)\)/
    : /(?:function\s+(\w+)|(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\()([^)]*)\)/;
  lines.forEach((line, i) => {
    const m = HEADER.exec(line);
    if (!m) return;
    const params = (m[2] || m[3] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (params.length > rule.params) {
      issues.push(mkIssue(rule, i + 1, line, `${(m[1] || m[2] || '函数')} 参数 ${params.length} 个 > ${rule.params} 个`, 1));
    }
  });
  return issues;
}

/** 重复函数名（同名定义第二次出现时报告） */
function dupFnIssues(code, lang, rules) {
  const rule = rules.find((r) => r.code === 'SC_DUP_FN' && r.langs.includes(lang));
  if (!rule) return [];
  const lines = String(code).split(/\r?\n/);
  const seen = new Map();
  const issues = [];
  const NAME_RES = [
    /\bfunction\s+([A-Za-z_$][\w$]*)/,
    lang === 'java'
      ? /(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\]]+\s+([A-Za-z_$][\w$]*)\s*\(/
      : /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>)/,
  ];
  lines.forEach((line, i) => {
    for (const re of NAME_RES) {
      const m = re.exec(line);
      if (!m) continue;
      const name = m[1];
      if (seen.has(name)) {
        if (seen.get(name).reported === false) {
          issues.push(mkIssue(rule, i + 1, line, `「${name}」首次定义在第 ${seen.get(name).line} 行，此处重复定义`, 1));
          seen.get(name).reported = true;
        }
      } else {
        seen.set(name, { line: i + 1, reported: false });
      }
    }
  });
  return issues;
}

/** 块级规则（超长函数：花括号深度扫描） */
function functionIssues(code, lang, rules) {
  const issues = [];
  const rule = rules.find((r) => r.code === 'SC_LONG_FN' && r.langs.includes(lang));
  if (!rule) return issues;
  const lines = String(code).split(/\r?\n/);
  const FN_START = lang === 'java'
    ? /(?:public|private|protected|static|\w)\s+[\w<>\[\]]+\s+\w+\s*\([^)]*\)\s*\{/
    : /(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\(|(?:async\s+)?\w+\s*\([^)]*\)\s*\{)/;
  let depth = 0;
  let start = -1;
  let startDepth = 0;
  lines.forEach((line, i) => {
    if (depth === startDepth && start >= 0 && /}\s*(?:;)?$/.test(line.trim())) {
      // 函数体结束
      const len = i - start + 1;
      if (len > rule.threshold) {
        issues.push(mkIssue(rule, start + 1, lines[start], `函数体 ${len} 行 > ${rule.threshold} 行`, 1));
      }
      start = -1;
    }
    if (start < 0 && depth >= 0 && FN_START.test(line) && /\{\s*$/.test(line)) {
      start = i;
      startDepth = depth;
    }
    depth += (line.match(/\{/g) || []).length;
    depth -= (line.match(/\}/g) || []).length;
  });
  if (start >= 0 && lines.length - start > rule.threshold) {
    issues.push(mkIssue(rule, start + 1, lines[start], `函数体 ${lines.length - start} 行 > ${rule.threshold} 行（未闭合或到文件尾）`, 1));
  }
  return issues;
}

function mkIssue(rule, line, sourceLine, hint, col) {
  return {
    rule: rule.code,
    name: rule.name,
    severity: rule.severity,
    line,
    col: col || null,
    excerpt: String(sourceLine || '').trim().slice(0, 80),
    detail: hint || '',
    guidance: rule.guidance,
  };
}

/** 规则目录（给前端展示「检查了什么、依据什么」；不含正则细节） */
function catalog() {
  return RULES.map((r) => ({
    code: r.code,
    name: r.name,
    severity: r.severity,
    langs: r.langs,
    guidance: r.guidance,
    threshold: r.threshold || r.depth || r.params || null,
  }));
}

/** 执行静态检查：输入代码，输出问题清单与汇总（不输出任何修复代码）
 *  opts.disabled：要关闭的规则 code 数组（教师/学生按需降噪） */
function run(code, { filename, language, disabled } = {}) {
  const src = String(code || '');
  if (!src.trim()) {
    throw Object.assign(new Error('代码为空，无法检查'), { status: 400 });
  }
  if (src.length > 200 * 1024) {
    throw Object.assign(new Error('代码超过 200KB 上限'), { status: 413 });
  }
  const lang = language === 'js' || language === 'java' ? language : detectLanguage(filename, src);
  const off = new Set(Array.isArray(disabled) ? disabled.map(String) : []);
  const rules = RULES.filter((r) => !off.has(r.code));
  const issues = [
    ...regexIssues(src, lang, rules),
    ...lineIssues(src, lang, rules),
    ...functionIssues(src, lang, rules),
    ...magicNumIssues(src, lang, rules),
    ...paramsIssues(src, lang, rules),
    ...dupFnIssues(src, lang, rules),
  ].sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));

  const bySeverity = { error: 0, warn: 0, info: 0 };
  const byRule = {};
  for (const i of issues) {
    bySeverity[i.severity]++;
    byRule[i.rule] = (byRule[i.rule] || 0) + 1;
  }
  return {
    issues,
    summary: {
      language: lang,
      totalIssues: issues.length,
      bySeverity,
      byRule,
      lines: src.split(/\r?\n/).length,
      rulesApplied: rules.length,
      rulesTotal: RULES.length,
      disabledRules: [...off].filter((c) => RULES.some((r) => r.code === c)),
    },
    note: '静态检查只给「问题清单 + 规范条目」，不提供修复后的代码——修改必须由你自己完成（FR-104 红线）。',
  };
}

/** 留痕 */
function logRun({ studentId, groupId, sessionId, ok, summary }) {
  const id = uid('run');
  db.insert('tool_runs', {
    run_id: id,
    tool: 'static',
    student_id: studentId || null,
    group_id: groupId || null,
    session_id: sessionId || null,
    ok: ok === false ? 0 : 1,
    summary: summary || {},
    created_at: now(),
  });
  return id;
}

module.exports = { run, logRun, RULES, catalog };
