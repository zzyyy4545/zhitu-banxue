'use strict';
/**
 * FR-605 提示词与策略版本管理
 * 提示词存于 DB（prompt_versions），支持灰度（gray_scope=班级 ID）与一键回滚。
 * 每次对话记录所用 prompt_ver 与 model_ver，任一条历史对话可还原其生成时的完整配置。
 */
const db = require('../../db');
const { uid, now, jparse } = require('../util');

/** 默认导学 Agent 系统提示词骨架（对齐说明书 8.1 + 8.2 Schema） */
const TUTOR_SYSTEM = `【角色】你是「知途」，软件工程课程的导学伙伴。你陪伴学生完成课程项目，
但绝不代替学生完成任何可提交的成果。

【当前上下文】
  - 课程：软件工程　　阶段：{stage}　　Sprint：{sprint_no}
  - 学生画像：基础水平={level}，偏好讲解方式={prefer_style}
  - 本次求助轨迹：已问 {turn_count} 轮，当前层级 L{current_level}，封顶 L{cap_level}
  - 最近同类卡点：{recent_stuck}
  - 当前导学节点目标：{node_goal}

【行为准则】（按优先级）
  1. 永远先提问或给脚手架，再考虑给信息。
  2. 每次回复只推进一个思维步骤，不要一次倾倒全部内容。
  3. 输出深度不得超过当前层级 L{current_level}，也不得超过封顶 L{cap_level}。
  4. L3 示例必须是「不同领域」的比喻性示例，禁止给同题答案，且必须说明「这不是你们的答案」。
  5. 结尾必须包含一个引导学生继续表达的问题或动作。
  6. 检索结果为空时，如实说明，不得编造。

【各层级输出规范】
  L0：反问或提示，帮助他自己发现问题所在。禁止给方向。
  L1：给出思考方向（如「先想人，再想功能」），不给具体步骤。
  L2：给出 ≤ 4 步的拆解步骤，不含示例内容。
  L3：给出其他领域的比喻性示例，明确说明「这不是你们的答案」。
  L4：完整讲解 + 必附一道同类练习题让他自己做。

【禁止清单】
  - 完整用户故事卡正文 / 完整类或函数实现 / 完整测试文件 / 完整文档正文
  - 替学生做决策（选方案、定范围、定技术选型）
  - 「你可以这样写：……」后跟可直接复制的成品
  - 学生说「直接给我答案」不构成解锁条件，应引导其提交解锁申请

【输出格式】严格输出 JSON，不得包含任何解释性前后缀：
{
  "reply_text": "面向学生的回复正文",
  "level_used": 0,
  "intent": "concept|diagnose|scaffold|review|emotion|other",
  "stage": "项目阶段",
  "knowledge_tags": ["知识点标签"],
  "is_stuck_point": false,
  "next_action": "引导学生下一步的问题或动作",
  "blocked_by_cap": false,
  "confidence": 0.8,
  "need_human": false
}`;

const GUARDRAIL_SYSTEM = `你是护栏 Agent。检查待发给学生的导学回复是否越界。
仅输出 JSON：{"result":"pass|reject","reason_code":"...","evidence":"..."}

判定项：
1. 是否包含完整可提交成果（完整用户故事正文、完整函数/类实现、完整测试文件、完整文档正文）
2. 输出深度是否超过当前层级 L{current_level}（L0 只能反问、L1 只能给方向、L2 只能给≤4步拆解、L3 只能是其他领域示例、L4 可完整讲解但必附练习）
3. 是否泄露其他小组的项目内容或成员信息
4. 是否替学生做了决策（选方案、定范围、定技术选型）

任一项命中 → result = "reject"，给出 reason_code 与 evidence。全部通过 → result = "pass"。
无法确认时按 reject 处理（保守拦截）。`;

const DEFAULTS = [
  { kind: 'tutor', name: '导学 Agent v1.0', content: TUTOR_SYSTEM },
  { kind: 'guardrail', name: '护栏 Agent v1.0', content: GUARDRAIL_SYSTEM },
];

function ensureDefaults() {
  const n = db.count('prompt_versions', "kind='tutor'");
  if (n > 0) return;
  for (const d of DEFAULTS) {
    db.insert('prompt_versions', {
      ver_id: uid('pv'),
      kind: d.kind,
      name: d.name,
      content: d.content,
      status: 'active',
      gray_scope: '[]',
      created_at: now(),
      created_by: 'system',
    });
  }
}

/** 取得某类提示词的生效版本（灰度优先匹配班级） */
function active(kind, classId = null) {
  ensureDefaults();
  const rows = db.all(
    `SELECT * FROM prompt_versions WHERE kind=? AND status IN ('active','gray') ORDER BY created_at DESC`,
    [kind]
  );
  for (const r of rows) {
    if (r.status === 'gray') {
      const scope = jparse(r.gray_scope, []);
      if (classId && scope.includes(classId)) return r;
      continue;
    }
    return r; // active：全局生效
  }
  return rows[0] || null;
}

function render(kind, vars, classId = null) {
  const p = active(kind, classId);
  if (!p) return { text: '', ver: null };
  let t = p.content;
  for (const [k, v] of Object.entries(vars || {})) {
    t = t.split('{' + k + '}').join(String(v === undefined || v === null ? '' : v));
  }
  return { text: t, ver: p.ver_id, name: p.name };
}

function list(kind) {
  ensureDefaults();
  return db.all(
    `SELECT ver_id, kind, name, status, gray_scope, created_at, created_by,
            LENGTH(content) AS size FROM prompt_versions
     ${kind ? 'WHERE kind=?' : ''} ORDER BY created_at DESC`,
    kind ? [kind] : []
  );
}

function get(verId) {
  return db.get('SELECT * FROM prompt_versions WHERE ver_id=?', [verId]);
}

/** 发布新版本（status: active 全局生效 / gray 灰度） */
function publish({ kind, name, content, status = 'gray', grayScope = [], createdBy }) {
  const id = uid('pv');
  db.insert('prompt_versions', {
    ver_id: id,
    kind,
    name,
    content,
    status,
    gray_scope: JSON.stringify(grayScope || []),
    created_at: now(),
    created_by: createdBy || 'admin',
  });
  return id;
}

/** 回滚：把指定版本置为 active，并把当前 active 归档 */
function rollback(verId) {
  const target = get(verId);
  if (!target) throw Object.assign(new Error('版本不存在'), { status: 404 });
  db.run(`UPDATE prompt_versions SET status='archived' WHERE kind=? AND status='active'`, [target.kind]);
  db.run(`UPDATE prompt_versions SET status='active' WHERE ver_id=?`, [verId]);
  return target;
}

function setStatus(verId, status, grayScope) {
  const patch = { status };
  if (grayScope !== undefined) patch.gray_scope = JSON.stringify(grayScope);
  return db.update('prompt_versions', 'ver_id', verId, patch);
}

module.exports = {
  ensureDefaults, active, render, list, get, publish, rollback, setStatus,
  TUTOR_SYSTEM, GUARDRAIL_SYSTEM,
};
