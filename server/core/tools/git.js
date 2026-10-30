'use strict';
/**
 * M2 工具层 · Git 提交轨迹分析（FR-203 / 6.2 外部对接）
 *
 * 三条通道：
 *   ① 平台只读 API（Gitea / GitLab / GitHub）—— syncRepo()
 *   ② 手工导入降级通道（学生粘贴 git log）—— importCommits()（规格说明书 6.2 降级方案）
 *   ③ 分析口径 —— analysis()：过程性提交频次、间隔方差、成员分布、提交信息质量
 *
 * 红线：只读取，绝不向仓库写入；分析只输出指标与提示，不替学生改提交信息。
 */
const db = require('../../db');
const { uid, now } = require('../util');

const PLATFORMS = ['gitea', 'gitlab', 'github', 'manual'];

// ---------------- 仓库登记 ----------------

function addRepo({ groupId, platform, url, token, defaultBranch }) {
  if (!groupId) throw Object.assign(new Error('缺少 groupId'), { status: 400 });
  if (!PLATFORMS.includes(platform)) {
    throw Object.assign(new Error(`platform 仅支持 ${PLATFORMS.join(' / ')}`), { status: 400 });
  }
  if (platform !== 'manual' && !/^https?:\/\//.test(String(url || ''))) {
    throw Object.assign(new Error('平台同步方式必须提供 http(s) 仓库地址'), { status: 400 });
  }
  const owner = platform === 'manual' ? null : ownerOf(url);
  const existed = db.get('SELECT * FROM git_repos WHERE group_id=? AND platform=?', [groupId, platform]);
  const id = existed ? existed.repo_id : uid('repo');
  if (existed) {
    db.update('git_repos', 'repo_id', id, {
      url, token, owner,
      default_branch: defaultBranch || existed.default_branch,
      status: 'active', last_error: null,
    });
  } else {
    db.insert('git_repos', {
      repo_id: id, group_id: groupId, platform, url, token,
      owner, default_branch: defaultBranch || 'main',
      status: 'active', created_at: now(),
    });
  }
  return { repoId: id, updated: !!existed };
}

function listRepos({ groupId } = {}) {
  return groupId
    ? db.all('SELECT * FROM git_repos WHERE group_id=? ORDER BY created_at', [groupId])
    : db.all('SELECT * FROM git_repos ORDER BY created_at');
}

/** 从仓库 URL 解析 owner/repo（GitHub/Gitea）—— 取路径最后两段 */
function ownerOf(url) {
  try {
    const u = new URL(url);
    const seg = u.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    return seg.slice(-2).join('/');
  } catch (_) {
    return null;
  }
}

// ---------------- 平台适配（只读） ----------------

async function fetchCommits(repo) {
  const branch = repo.default_branch || 'main';
  const base = new URL(repo.url).origin;
  if (repo.platform === 'gitea') {
    const r = await jsonFetch(
      `${base}/api/v1/repos/${repo.owner}/commits?limit=50&sha=${encodeURIComponent(branch)}&token=${repo.token || ''}`
    );
    return (r.data || []).map((c) => ({
      sha: c.sha,
      author: (c.commit && c.commit.author && c.commit.author.name) || c.author_name || '未知',
      date: (c.commit && c.commit.author && c.commit.author.date) || c.created,
      message: (c.commit && c.commit.message) || '',
    }));
  }
  if (repo.platform === 'gitlab') {
    const r = await jsonFetch(
      `${base}/api/v4/projects/${encodeURIComponent(repo.owner)}/repository/commits?per_page=50&ref_name=${encodeURIComponent(branch)}`,
      { 'PRIVATE-TOKEN': repo.token || '' }
    );
    return (r.data || []).map((c) => ({
      sha: c.id, author: c.author_name, date: c.committed_date, message: c.message,
    }));
  }
  if (repo.platform === 'github') {
    const r = await jsonFetch(
      `https://api.github.com/repos/${repo.owner}/commits?per_page=50&sha=${encodeURIComponent(branch)}`,
      { Authorization: repo.token ? `Bearer ${repo.token}` : '' }
    );
    return (r.data || []).map((c) => ({
      sha: c.sha,
      author: (c.commit && c.commit.author && c.commit.author.name) || '未知',
      date: c.commit && c.commit.author && c.commit.author.date,
      message: (c.commit && c.commit.message) || '',
    }));
  }
  throw Object.assign(new Error('manual 通道没有平台 API，请走手工导入'), { status: 400 });
}

/** 带超时的只读请求；失败抛错（由调用方降级为 status=unreachable，不静默、不编造） */
async function jsonFetch(url, headers = {}, timeoutMs = 12000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'zhitu-tutor/1.0', ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw Object.assign(new Error(`平台返回 ${res.status}${data && data.message ? '：' + data.message : ''}`), { status: 502 });
  }
  return { data };
}

/** 同步一个仓库：拉取提交并入库（按 sha 去重） */
async function syncRepo(repoId) {
  const repo = db.get('SELECT * FROM git_repos WHERE repo_id=?', [repoId]);
  if (!repo) throw Object.assign(new Error('仓库不存在'), { status: 404 });
  const t0 = Date.now();
  try {
    const commits = await fetchCommits(repo);
    const inserted = saveCommits(repo.group_id, commits, repo.repo_id);
    db.update('git_repos', 'repo_id', repoId, {
      status: 'active', last_synced_at: now(), last_error: null,
    });
    return {
      ok: true, fetched: commits.length, inserted, latencyMs: Date.now() - t0,
      note: '只读同步：仅拉取提交轨迹，不写入仓库',
    };
  } catch (e) {
    // 降级路径（说明书 9.2 故障演练：Git 平台不可达）：标记状态并留错误线索，可用手工导入兜底
    db.update('git_repos', 'repo_id', repoId, {
      status: 'unreachable', last_synced_at: now(), last_error: e.message,
    });
    return { ok: false, error: e.message, latencyMs: Date.now() - t0, suggest: '平台不可达，可让学生手工粘贴提交记录（导入通道）' };
  }
}

// ---------------- 手工导入（降级通道） ----------------

/**
 * 解析学生粘贴的提交记录。
 * 支持两种格式：
 *   ① 每行一条：sha|日期|作者|提交信息（前三段可省略后段，字段用 | 分隔，日期在前或在 sha 后均可）
 *   ② JSON 数组：[{sha, date, author, message, branch}]
 */
function parseRaw(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) return arr.map(normalizeLine).filter(Boolean);
    } catch (_) {
      throw Object.assign(new Error('JSON 解析失败，请检查格式'), { status: 400 });
    }
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows = [];
  for (const line of lines) {
    const parts = line.split('|').map((x) => x.trim());
    if (parts.length < 2) continue;
    let sha = '', date = '', author = '', message = '';
    if (parts.length === 4) {
      // sha|日期|作者|信息 或 sha|作者|日期|信息 —— 用「像不像日期」判别
      if (looksLikeDate(parts[1])) { [sha, date, author, message] = parts; }
      else if (looksLikeDate(parts[2])) { [sha, author, date, message] = parts; }
      else { [sha, date, author, message] = parts; }
    } else if (parts.length === 3) {
      if (looksLikeDate(parts[1])) { [sha, date, message] = parts; }
      else if (looksLikeDate(parts[0])) { [date, author, message] = parts; }
      else { [author, date, message] = parts; }
    } else if (parts.length === 2) {
      [date, message] = parts;
      if (!looksLikeDate(date)) { [sha, message] = parts; sha = ''; date = ''; }
    }
    const row = normalizeLine({ sha, date, author, message });
    if (row) rows.push(row);
  }
  return rows;
}

function looksLikeDate(s) {
  return /^\d{4}-\d{2}-\d{2}/.test(String(s || '')) || /^\d{10,14}$/.test(String(s || ''));
}

function normalizeLine(r) {
  const sha = String(r.sha || r.id || '').replace(/[^0-9a-f]/gi, '').slice(0, 12) || 'imp_' + Math.random().toString(16).slice(2, 10);
  let date = r.date || r.committed_at || '';
  if (/^\d{10,14}$/.test(String(date))) {
    date = new Date(Number(date.length > 10 ? date.padEnd(13, '0') : date + '000')).toISOString();
  } else if (date && !/Z$/.test(date) && !/\+/.test(date) && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    date = new Date(date.replace(' ', 'T') + 'Z').toISOString();
  }
  if (!date || isNaN(new Date(date).getTime())) date = now();
  return {
    sha,
    author: r.author || r.author_name || '未知',
    date: new Date(date).toISOString(),
    message: String(r.message || '').slice(0, 300),
    branch: r.branch || null,
  };
}

function importCommits({ groupId, raw }) {
  if (!groupId) throw Object.assign(new Error('缺少 groupId'), { status: 400 });
  const rows = parseRaw(raw);
  if (!rows.length) {
    throw Object.assign(new Error('未解析到任何提交记录；支持「sha|日期|作者|提交信息」逐行或 JSON 数组格式'), { status: 400 });
  }
  const inserted = saveCommits(groupId, rows);
  db.run(
    `INSERT INTO git_repos (repo_id, group_id, platform, status, last_synced_at, created_at)
     SELECT ?, ?, 'manual', 'active', ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM git_repos WHERE group_id=? AND platform='manual')`,
    [uid('repo'), groupId, now(), now(), groupId]
  );
  return { ok: true, imported: rows.length, inserted, format: 'manual' };
}

/** 提交入库：按 (group_id, sha) 去重，作者尽力匹配学生 */
function saveCommits(groupId, rows, repoId) {
  let inserted = 0;
  const members = db.all('SELECT student_id, name FROM students WHERE group_id=?', [groupId]);
  for (const r of rows) {
    const norm = normalizeLine(r);
    const match = members.find((m) => m.name === norm.author);
    try {
      db.run(
        `INSERT INTO git_commits (id, repo_id, group_id, sha, author_name, author_student_id, message, branch, files_changed, additions, deletions, committed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(group_id, sha) DO NOTHING`,
        [
          groupId + ':' + norm.sha, repoId || null, groupId, norm.sha,
          norm.author, match ? match.student_id : null,
          norm.message, norm.branch || null,
          r.files_changed || 0, r.additions || 0, r.deletions || 0, norm.date,
        ]
      );
      if (db.get('SELECT changes() AS c').c > 0) inserted++;
    } catch (_) {
      /* 冲突则忽略 */
    }
  }
  return inserted;
}

// ---------------- 分析口径 ----------------

/** 低信息量提交信息（与编码阶段「提交信息」节点同一判据） */
const LOW_INFO_MSG_RE = /^(修改|更新|fix|update|change|改了点?|调整|test|测试|提交|commit|.[a-z])$/i;

function isLowInfoMessage(msg) {
  const m = String(msg || '').split('\n')[0].trim();
  return !m || m.length < 6 || LOW_INFO_MSG_RE.test(m);
}

/** Conventional Commits 规范：type[(scope)][!]: subject */
const CONVENTIONAL_RE = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]{1,20}\))?(!)?: \S.{4,}/;

/** 提交信息类型归类（feat/fix/…/其他） */
function messageType(msg) {
  const m = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\(|:|!)/i.exec(String(msg || '').split('\n')[0].trim());
  return m ? m[1].toLowerCase() : 'other';
}

/** 提交信息规范分析：类型分布、规范符合率、低信息明细 */
function messageQuality(commits) {
  const typeDistribution = {};
  let conventional = 0;
  const lowInfoList = [];
  for (const c of commits) {
    const t = messageType(c.message);
    typeDistribution[t] = (typeDistribution[t] || 0) + 1;
    if (CONVENTIONAL_RE.test(String(c.message || '').split('\n')[0].trim())) conventional++;
    if (isLowInfoMessage(c.message)) {
      lowInfoList.push({ sha: c.sha, author: c.author_name, message: c.message, committedAt: c.committed_at });
    }
  }
  return {
    typeDistribution,
    conventional,
    conventionalRatio: commits.length ? +(conventional / commits.length).toFixed(2) : 0,
    lowInfoList: lowInfoList.slice(0, 10),
  };
}

/** 提交时段分布（0-23 时直方图）与深夜/凌晨占比 */
function hourHistogram(commits) {
  const hours = new Array(24).fill(0);
  let late = 0;
  let valid = 0;
  for (const c of commits) {
    const d = new Date(c.committed_at);
    if (isNaN(d.getTime())) continue;
    valid++;
    const h = d.getHours();
    hours[h]++;
    if (h >= 0 && h < 7) late++;
  }
  return {
    hours,
    lateNight: late,
    lateNightRatio: valid ? +(late / valid).toFixed(2) : 0,
    peakHour: hours.indexOf(Math.max(...hours)),
  };
}

/** 单组提交轨迹分析（FR-203 产出物：提交轨迹分析）
 *  @param {object} opts { from, to }——日期区间筛选（YYYY-MM-DD，含边界） */
function groupAnalysis(groupId, { from, to } = {}) {
  let commits = db.all(
    'SELECT * FROM git_commits WHERE group_id=? ORDER BY committed_at',
    [groupId]
  );
  if (from) commits = commits.filter((c) => String(c.committed_at).slice(0, 10) >= from);
  if (to) commits = commits.filter((c) => String(c.committed_at).slice(0, 10) <= to);
  const repos = db.all('SELECT * FROM git_repos WHERE group_id=?', [groupId]);
  if (!commits.length) {
    return {
      groupId, count: 0, activeDays: 0, perDay: 0, intervalVarianceH: 0,
      lastCommitAt: null, daysSinceLast: null, members: [],
      lowInfoMessages: 0, lowInfoRatio: 0, rhythms: [], commits: [], repos,
      messageQuality: messageQuality([]), hourHistogram: hourHistogram([]),
      codeVolume: { additions: 0, deletions: 0, filesChanged: 0, hasStats: false },
      range: { from: from || null, to: to || null },
    };
  }
  const days = [...new Set(commits.map((c) => String(c.committed_at).slice(0, 10)))];
  const ts = commits.map((c) => new Date(c.committed_at).getTime()).filter((x) => !isNaN(x));
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 3600000);
  const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
  const variance = gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / (gaps.length || 1);

  const last = commits[commits.length - 1];
  const daysSinceLast = Math.floor((Date.now() - new Date(last.committed_at).getTime()) / 86400000);

  // 成员分布（贡献分析——只列事实，不排名不评分，FR-303 红线同源）
  const byAuthor = new Map();
  for (const c of commits) {
    const k = c.author_student_id || 'x:' + (c.author_name || '未知');
    const cur = byAuthor.get(k) || {
      author: c.author_name || '未知', studentId: c.author_student_id, count: 0,
      lowInfo: 0, last: c.committed_at, first: c.committed_at,
      activeDaysSet: new Set(), additions: 0, deletions: 0,
    };
    cur.count++;
    if (isLowInfoMessage(c.message)) cur.lowInfo++;
    if (new Date(c.committed_at) > new Date(cur.last)) cur.last = c.committed_at;
    if (new Date(c.committed_at) < new Date(cur.first)) cur.first = c.committed_at;
    cur.activeDaysSet.add(String(c.committed_at).slice(0, 10));
    cur.additions += Number(c.additions) || 0;
    cur.deletions += Number(c.deletions) || 0;
    byAuthor.set(k, cur);
  }
  const members = [...byAuthor.values()].map((m) => ({
    author: m.author, studentId: m.studentId, count: m.count,
    lowInfo: m.lowInfo, lowInfoRatio: +(m.lowInfo / m.count).toFixed(2),
    activeDays: m.activeDaysSet.size,
    firstCommitAt: m.first, lastCommitAt: m.last,
    additions: m.additions, deletions: m.deletions,
    perActiveDay: +(m.count / Math.max(1, m.activeDaysSet.size)).toFixed(2),
  })).sort((a, b) => b.count - a.count);

  const lowInfoMessages = commits.filter((c) => isLowInfoMessage(c.message)).length;

  // 代码量统计（平台同步 / JSON 导入带增删行数时才有值）
  const additions = commits.reduce((a, c) => a + (Number(c.additions) || 0), 0);
  const deletions = commits.reduce((a, c) => a + (Number(c.deletions) || 0), 0);
  const filesChanged = commits.reduce((a, c) => a + (Number(c.files_changed) || 0), 0);
  const hasStats = commits.some((c) => Number(c.additions) || Number(c.deletions));

  // 节奏风险信号（供预警与教师端展示；只描述事实，不下结论）
  const rhythms = [];
  if (daysSinceLast >= 3) rhythms.push({ code: 'no_commit_3d', text: `已 ${daysSinceLast} 天无提交` });
  const recent48h = commits.filter(
    (c) => Date.now() - new Date(c.committed_at).getTime() <= 48 * 3600000
  ).length;
  if (commits.length >= 5 && recent48h / commits.length > 0.5) {
    rhythms.push({ code: 'deadline_rush', text: '超过一半提交集中在近 48 小时（临近截止集中提交）' });
  }
  if (gaps.length >= 3 && variance > 400) {
    rhythms.push({ code: 'irregular_cadence', text: '提交间隔方差大，节奏不均（间隔方差 ' + variance.toFixed(0) + ' h²）' });
  }
  const hourStats = hourHistogram(commits);
  if (commits.length >= 10 && hourStats.lateNightRatio >= 0.3) {
    rhythms.push({ code: 'late_night', text: `${Math.round(hourStats.lateNightRatio * 100)}% 提交发生在 0–7 点（深夜赶工倾向）` });
  }
  const byDay = new Map();
  for (const c of commits) {
    const d = String(c.committed_at).slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  const maxDay = Math.max(...byDay.values());
  if (commits.length >= 8 && maxDay / commits.length >= 0.4) {
    rhythms.push({ code: 'burst_day', text: `单日最多 ${maxDay} 次提交，占总量 ${Math.round(maxDay / commits.length * 100)}%（集中突击）` });
  }

  return {
    groupId,
    count: commits.length,
    activeDays: days.length,
    perDay: +(commits.length / Math.max(1, days.length)).toFixed(2),
    intervalVarianceH: +variance.toFixed(1),
    meanIntervalH: +mean.toFixed(1),
    lastCommitAt: last.committed_at,
    daysSinceLast,
    members,
    lowInfoMessages,
    lowInfoRatio: +(lowInfoMessages / commits.length).toFixed(2),
    rhythms,
    messageQuality: messageQuality(commits),
    hourHistogram: hourStats,
    codeVolume: { additions, deletions, filesChanged, hasStats },
    commits: commits.slice(-100).reverse().map((c) => ({
      ...c, additions: Number(c.additions) || 0, deletions: Number(c.deletions) || 0,
      files_changed: Number(c.files_changed) || 0,
    })),
    repos,
    range: { from: from || null, to: to || null },
  };
}

/** 班级维度的提交频次汇总（教师看板） */
function analysis({ classId, groupId } = {}) {
  const where = groupId ? 'g.group_id=?' : classId ? 'g.class_id=?' : null;
  const groups = db.all(
    `SELECT g.group_id, g.project_name, g.class_id, g.sprint_no FROM groups g
     ${where ? 'WHERE ' + where : ''} ORDER BY g.group_id LIMIT 200`,
    where ? [groupId || classId] : []
  );
  const list = groups.map((g) => {
    const a = groupAnalysis(g.group_id);
    return {
      groupId: g.group_id, projectName: g.project_name, sprintNo: g.sprint_no,
      count: a.count, activeDays: a.activeDays, perDay: a.perDay,
      intervalVarianceH: a.intervalVarianceH, daysSinceLast: a.daysSinceLast,
      lastCommitAt: a.lastCommitAt, lowInfoRatio: a.lowInfoRatio,
      members: a.members.length, rhythms: a.rhythms,
      repoStatus: a.repos.map((r) => ({ platform: r.platform, status: r.status, lastSyncedAt: r.last_synced_at, lastError: r.last_error })),
    };
  });
  const withCommits = list.filter((x) => x.count > 0);
  return {
    groups: list,
    totals: {
      groups: list.length,
      withGit: withCommits.length,
      commits: withCommits.reduce((a, b) => a + b.count, 0),
      avgPerDay: withCommits.length
        ? +(withCommits.reduce((a, b) => a + b.perDay, 0) / withCommits.length).toFixed(2)
        : 0,
      noCommitGroups: list.filter((x) => x.count === 0).map((x) => x.groupId),
      riskGroups: list.filter((x) => x.rhythms.length > 0).map((x) => x.groupId),
    },
  };
}

/** 某组最近一次提交时间（供预警判定「连续无提交」） */
function lastCommitAt(groupId) {
  const r = db.get(
    'SELECT MAX(committed_at) AS t FROM git_commits WHERE group_id=?',
    [groupId]
  );
  return r ? r.t : null;
}

/** 组提交轨迹分析报告（教师导出用）：JSON 结构 + 可读文本两种形态 */
function exportReport(groupId, { from, to } = {}) {
  const group = db.get('SELECT * FROM groups WHERE group_id=?', [groupId]);
  const a = groupAnalysis(groupId, { from, to });
  const mq = a.messageQuality;
  const hs = a.hourHistogram;

  const lines = [];
  lines.push(`# 提交轨迹分析报告 · ${groupId}`);
  lines.push(`项目：${(group && group.project_name) || '未知'}　生成时间：${now()}` +
    (a.range.from || a.range.to ? `　区间：${a.range.from || '…'} ~ ${a.range.to || '…'}` : ''));
  lines.push('');
  lines.push('## 总览');
  lines.push(`- 提交 ${a.count} 次 / 活跃 ${a.activeDays} 天 / 平均 ${a.perDay} 次/活跃日`);
  lines.push(`- 提交间隔方差 ${a.intervalVarianceH} h²（平均间隔 ${a.meanIntervalH} h）`);
  lines.push(`- 最后提交：${a.lastCommitAt || '—'}（距今 ${a.daysSinceLast ?? '—'} 天）`);
  lines.push(`- 代码量：+${a.codeVolume.additions} 行 / -${a.codeVolume.deletions} 行 / 改动文件 ${a.codeVolume.filesChanged} 个` +
    (a.codeVolume.hasStats ? '' : '（导入数据未含行数统计）'));
  lines.push(`- 提交信息规范符合率 ${Math.round(mq.conventionalRatio * 100)}%（Conventional Commits）· 低信息提交 ${Math.round(a.lowInfoRatio * 100)}%`);
  lines.push('');
  lines.push('## 提交信息类型分布');
  lines.push(Object.entries(mq.typeDistribution).map(([t, n]) => `${t}×${n}`).join('　') || '—');
  lines.push('');
  lines.push('## 时段分布（0–23 时）');
  lines.push(hs.hours.map((n, h) => `${String(h).padStart(2, '0')}时${'█'.repeat(Math.min(10, n))}${n || ''}`).join('\n'));
  lines.push(`高峰时段 ${String(hs.peakHour).padStart(2, '0')}:00 · 深夜提交（0–7 点）占 ${Math.round(hs.lateNightRatio * 100)}%`);
  lines.push('');
  lines.push('## 成员事实（不评分、不排名）');
  for (const m of a.members) {
    lines.push(`- ${m.author}：提交 ${m.count} 次 / 活跃 ${m.activeDays} 天 / 低信息 ${Math.round(m.lowInfoRatio * 100)}% / 首末 ${String(m.firstCommitAt).slice(0, 10)} ~ ${String(m.lastCommitAt).slice(0, 10)}${m.additions || m.deletions ? ` / 代码 +${m.additions} -${m.deletions}` : ''}`);
  }
  lines.push('');
  lines.push('## 节奏信号');
  lines.push(a.rhythms.length ? a.rhythms.map((r) => `- ${r.text}`).join('\n') : '- 无');
  lines.push('');
  lines.push('> 红线说明：本报告只呈现过程事实，成员贡献评价由小组自评互评完成（FR-303），诚信结论由教师判定（FR-604）。');

  return { groupId, projectName: (group && group.project_name) || null, generatedAt: now(), analysis: a, text: lines.join('\n') };
}

module.exports = {
  addRepo, listRepos, syncRepo, importCommits, parseRaw,
  groupAnalysis, analysis, lastCommitAt, exportReport, isLowInfoMessage,
  messageType, PLATFORMS,
};
