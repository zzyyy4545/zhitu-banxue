'use strict';
/**
 * FR-602 学习者画像
 * 每次求助事件结束后增量更新；仅用于策略选择，不用于排名或评价（边界条款）
 * 学生可查看自己的画像并可申诉修正（透明原则）
 */
const db = require('../db');
const { uid, now, jparse } = require('./util');
const stages = require('./stages');

function ensure(studentId) {
  const p = db.get('SELECT * FROM learner_profiles WHERE student_id=?', [studentId]);
  if (p) return p;
  db.insert('learner_profiles', {
    student_id: studentId,
    base_level: '初学',
    prefer_style: '类比',
    progress: '{}',
    stuck_tags: '[]',
    level_distribution: '{}',
    avg_turns: 0,
    activity_pattern: '{}',
    emotion_signals: 0,
    updated_at: now(),
  });
  return db.get('SELECT * FROM learner_profiles WHERE student_id=?', [studentId]);
}

function get(studentId) {
  return ensure(studentId);
}

/** 求助事件结束时增量更新 */
function onEventClosed(studentId, event) {
  const p = ensure(studentId);
  const dist = jparse(p.level_distribution, {});
  const lvl = String(event.max_level || 0);
  dist[lvl] = (dist[lvl] || 0) + 1;

  const tags = jparse(p.stuck_tags, []);
  for (const t of jparse(event.knowledge_tags, [])) {
    const hit = tags.find((x) => x.name === t);
    if (hit) hit.count += 1;
    else tags.push({ name: t, count: 1 });
  }
  tags.sort((a, b) => b.count - a.count);

  // 平均解决轮次（增量近似）
  const total = Object.values(dist).reduce((a, b) => a + b, 0);
  const prevAvg = p.avg_turns || 0;
  const avg = total > 1 ? +((prevAvg * (total - 1) + (event.turn_count || 0)) / total).toFixed(2) : event.turn_count || 0;

  // 阶段进度
  const progress = jparse(p.progress, {});
  const cfg = stages.get(event.stage);
  if (cfg) progress[event.stage] = Math.max(progress[event.stage] || 0, 100 / cfg.nodes.length * (cfg.nodes.length));

  // 基础水平：L0–L1 结束占比高 → 进阶
  const low = (dist['0'] || 0) + (dist['1'] || 0);
  const baseLevel = total >= 5 && low / total >= 0.6 ? '进阶' : p.base_level;

  db.update('learner_profiles', 'student_id', studentId, {
    level_distribution: JSON.stringify(dist),
    stuck_tags: JSON.stringify(tags.slice(0, 12)),
    avg_turns: avg,
    progress: JSON.stringify(progress),
    base_level: baseLevel,
    updated_at: now(),
  });
  return get(studentId);
}

/** 情绪信号计数（FR-106） */
function bumpEmotion(studentId) {
  const p = ensure(studentId);
  db.update('learner_profiles', 'student_id', studentId, {
    emotion_signals: (p.emotion_signals || 0) + 1,
    updated_at: now(),
  });
}

/** 学生申诉修正（透明原则），写入审计由调用方负责 */
function appeal(studentId, patch, reason) {
  const allowed = {};
  if (patch.baseLevel) allowed.base_level = patch.baseLevel;
  if (patch.preferStyle) allowed.prefer_style = patch.preferStyle;
  allowed.updated_at = now();
  db.update('learner_profiles', 'student_id', studentId, allowed);
  return { ok: true, reason, profile: get(studentId) };
}

module.exports = { ensure, get, onEventClosed, bumpEmotion, appeal };
