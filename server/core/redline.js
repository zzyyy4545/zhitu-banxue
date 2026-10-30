'use strict';
/**
 * FR-108 答案红线拦截 —— 独立于模型的规则层，作为最后一道防线
 *
 * 规则库存于 DB（redline_rules），支持运行时增删改 = 可配置、可热更新（验收标准）。
 * 规则类型：
 *   regex      param:{pattern, flags}        文本正则命中
 *   code_lines param:{maxLines}              代码块行数超过阈值
 *   count      param:{pattern, min}          某模式出现次数 >= min
 *   doc_struct param:{minLength, minHeadings} 成篇文档结构（标题数 + 长度）
 *
 * 命中且「当前层级 <= max_level」→ 拦截并替换为引导话术；L4 放行（教师已授权）。
 * 所有拦截写入 guardrail_logs，并计入教师端「越界尝试」统计。
 */
const db = require('../db');
const { uid, now, jparse, maxCodeBlockLines } = require('./util');

const DEFAULT_RULES = [
  {
    name: '完整代码块（>15 行且可直接运行）',
    kind: 'code_lines',
    param: { maxLines: 15 },
    stage: null,
    max_level: 3,
    reason_code: 'RL_FULL_CODE',
    replacement: '这一步我不能把整段代码交给你——交上去就不是你写的了。\n我把实现拆成几步，你先说第一步打算怎么落手？卡在哪一行我们再细看。',
  },
  {
    name: '完整三段式用户故事成品',
    kind: 'regex',
    param: {
      pattern: '(作(为|為)[^。\\n]{2,40}[，,、]?\\s*我(想|希望|需要|要)[^。\\n]{2,80}[，,、]?\\s*(以便|从而|这样|这样我)[^。\\n]{2,80})',
      flags: '',
    },
    stage: 'requirements',
    max_level: 3,
    reason_code: 'RL_FULL_STORY',
    replacement: '故事卡得由你来写，我只给句式和填空位：作为〈谁〉，我想〈做什么〉，以便〈什么价值〉。\n你先把「谁」填出来——要具体到能找去访谈的人，写「用户」不算。',
  },
  {
    name: '完整测试用例文件',
    kind: 'count',
    param: { pattern: '@Test|def test_|it\\(|describe\\(', min: 2 },
    stage: 'testing',
    max_level: 3,
    reason_code: 'RL_FULL_TESTFILE',
    replacement: '测试文件我不能替你写。先做一件事：把被测功能的所有输入分成几个等价类，说给我听。\n分完类，边界值和异常分支自然就出来了。',
  },
  {
    name: '成篇设计文档正文',
    kind: 'doc_struct',
    param: { minLength: 600, minHeadings: 3 },
    stage: 'architecture',
    max_level: 3,
    reason_code: 'RL_FULL_DOC',
    replacement: '完整文档正文我不会给——那等于替你交作业。\n我给你骨架和每个小节要回答的问题，内容你自己填。先说第一节：这个系统最关键的质量属性是哪一个？',
  },
  {
    name: '可直接复制的成品前缀',
    kind: 'regex',
    param: { pattern: '(你可以(这样|这么|按下面|直接)(写|实现|用|复制))|(完整(实现|代码|版本)如下)|(下面是(完整|可直接))', flags: '' },
    stage: null,
    max_level: 3,
    reason_code: 'RL_COPY_PASTE',
    replacement: '「你可以这样写」后面接成品——这个组合我不会输出。\n换个方式：你先说说打算怎么写，我听哪里站不住，再帮你拆。',
  },
  {
    name: '完整演示稿 / 答辩答案正文',
    kind: 'doc_struct',
    param: { minLength: 400, minHeadings: 2 },
    stage: 'review',
    max_level: 3,
    reason_code: 'RL_FULL_DEMO',
    replacement: '演示稿正文要你自己写，我只能给提纲和每页要回答的问题。\n先定结构：问题 → 方案 → 证据。你说第一个「问题」打算怎么开场？',
  },
  {
    name: '完整复盘报告正文',
    kind: 'doc_struct',
    param: { minLength: 400, minHeadings: 2 },
    stage: 'retro',
    max_level: 3,
    reason_code: 'RL_FULL_RETRO',
    replacement: '复盘报告我给结构不给正文：做得好 / 待改进 / 下一步行动。\n先说第一条「做得好」——要具体到一件事，不要写「大家都很努力」。',
  },
];

function ensureDefaults() {
  const n = db.count('redline_rules');
  if (n > 0) return;
  for (const r of DEFAULT_RULES) {
    db.insert('redline_rules', {
      rule_id: uid('rl'),
      name: r.name,
      kind: r.kind,
      param: JSON.stringify(r.param),
      stage: r.stage,
      max_level: r.max_level,
      reason_code: r.reason_code,
      replacement: r.replacement,
      enabled: 1,
      updated_at: now(),
    });
  }
}

function evalRule(rule, text) {
  const p = jparse(rule.param, {});
  switch (rule.kind) {
    case 'regex': {
      try {
        const re = new RegExp(p.pattern, p.flags || '');
        const m = text.match(re);
        return m ? { hit: true, evidence: m[0].slice(0, 120) } : { hit: false };
      } catch (_) {
        return { hit: false };
      }
    }
    case 'code_lines': {
      const n = maxCodeBlockLines(text);
      return n > (p.maxLines || 15)
        ? { hit: true, evidence: `代码块 ${n} 行 > ${p.maxLines} 行` }
        : { hit: false };
    }
    case 'count': {
      try {
        const re = new RegExp(p.pattern, 'g');
        const c = (text.match(re) || []).length;
        return c >= (p.min || 2)
          ? { hit: true, evidence: `匹配 ${c} 次 >= ${p.min}` }
          : { hit: false };
      } catch (_) {
        return { hit: false };
      }
    }
    case 'doc_struct': {
      const headings = (text.match(/^\s{0,3}#{1,6}\s+.+$|^\s*\d+[、.．]\s*\S+/gm) || []).length;
      const len = text.length;
      return len >= (p.minLength || 600) && headings >= (p.minHeadings || 3)
        ? { hit: true, evidence: `正文 ${len} 字 / ${headings} 个标题` }
        : { hit: false };
    }
    default:
      return { hit: false };
  }
}

/**
 * 执行红线拦截
 * @returns {{blocked:boolean, text:string, reason_code?:string, rule?:string, evidence?:string}}
 */
function check(text, { level = 0, stage = null } = {}) {
  ensureDefaults();
  const rules = db.all('SELECT * FROM redline_rules WHERE enabled=1');
  for (const r of rules) {
    if (r.stage && stage && r.stage !== stage) continue;
    if (level > r.max_level) continue; // L4 或教师解锁后放行
    const res = evalRule(r, String(text || ''));
    if (res.hit) {
      return {
        blocked: true,
        text: r.replacement || '这一步我不能给你成品。我们拆开看：你先说说现在卡在哪一步？',
        reason_code: r.reason_code,
        rule: r.name,
        evidence: res.evidence,
      };
    }
  }
  return { blocked: false, text };
}

function listRules() {
  ensureDefaults();
  return db.all('SELECT * FROM redline_rules ORDER BY updated_at DESC');
}

function addRule(r) {
  const id = uid('rl');
  db.insert('redline_rules', {
    rule_id: id,
    name: r.name,
    kind: r.kind,
    param: JSON.stringify(r.param || {}),
    stage: r.stage || null,
    max_level: r.max_level === undefined ? 3 : r.max_level,
    reason_code: r.reason_code || 'RL_CUSTOM',
    replacement: r.replacement || null,
    enabled: r.enabled === undefined ? 1 : r.enabled,
    updated_at: now(),
  });
  return id;
}

function updateRule(id, patch) {
  const p = { ...patch };
  if (p.param) p.param = JSON.stringify(p.param);
  p.updated_at = now();
  return db.update('redline_rules', 'rule_id', id, p);
}

function deleteRule(id) {
  return db.run('DELETE FROM redline_rules WHERE rule_id=?', [id]);
}

module.exports = { check, listRules, addRule, updateRule, deleteRule, ensureDefaults, DEFAULT_RULES };
