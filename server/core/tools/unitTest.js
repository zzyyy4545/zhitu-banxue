'use strict';
/**
 * M2 工具层 · 单测执行（FR-204 测试验证阶段）
 *
 * 零依赖方案：学生提交 node:test 风格的测试文件 → 子进程隔离执行 → 解析 TAP。
 * 红线：系统绝不替学生写测试文件；只报告运行结果与失败线索（FR-204「不输出完整测试文件」同源）。
 *
 * 沙箱约束：
 *   - 独立临时目录，运行完即删；
 *   - 硬超时（默认 15s）防止死循环；
 *   - 代码体积 ≤ 200KB、文件数 ≤ 5（对齐 FR-105 输入边界）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const db = require('../../db');
const { uid, now } = require('../util');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_FILES = 5;
const MAX_TOTAL_BYTES = 200 * 1024;

/**
 * 执行学生测试文件
 * @param {Array<{name:string, content:string}>} files
 * @param {object} opts { entry, coverage, timeoutMs }
 * @returns {Promise<{ok, tests, pass, fail, skipped, failures, coverage, stdout, durationMs, timedOut}>}
 */
function runTests(files, { entry, coverage = false, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    if (!Array.isArray(files) || !files.length) {
      return resolve(failResult('未提供测试文件', { ok: false }));
    }
    if (files.length > MAX_FILES) {
      return resolve(failResult(`文件数超过上限（≤ ${MAX_FILES} 个）`, { ok: false }));
    }
    const total = files.reduce((a, f) => a + Buffer.byteLength(String(f.content || ''), 'utf8'), 0);
    if (total > MAX_TOTAL_BYTES) {
      return resolve(failResult(`代码总量超过 200KB 上限`, { ok: false }));
    }
    const jsFiles = files.filter((f) => /\.(js|mjs|cjs)$/i.test(String(f.name || '')));
    if (!jsFiles.length) {
      return resolve(failResult('只支持 JavaScript 测试文件（node:test）', { ok: false }));
    }
    const entryFile =
      (entry && jsFiles.find((f) => f.name === entry)) ||
      jsFiles.find((f) => /test|spec/i.test(String(f.name))) ||
      jsFiles[0];

    let dir;
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhitu-test-'));
      for (const f of jsFiles) {
        const safe = path.basename(String(f.name || 'test.js')).replace(/[^\w.-]/g, '_');
        fs.writeFileSync(path.join(dir, safe), String(f.content || ''), 'utf8');
      }
    } catch (e) {
      return resolve(failResult('临时目录创建失败：' + e.message, { ok: false }));
    }

    const t0 = Date.now();
    const args = [path.join(dir, path.basename(entryFile.name))];
    if (coverage) args.unshift('--experimental-test-coverage');
    const child = spawn(process.execPath, args, {
      cwd: dir,
      env: { PATH: process.env.PATH || '', NODE_OPTIONS: '', NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { out += d.toString(); if (out.length > 512 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 512 * 1024) child.kill('SIGKILL'); });
    child.on('error', (e) => {
      clearTimeout(timer);
      cleanup(dir);
      resolve(failResult('执行失败：' + e.message, { ok: false, durationMs: Date.now() - t0 }));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      cleanup(dir);
      const result = parseTap(out + '\n' + err, code, timedOut, Date.now() - t0);
      resolve(result);
    });
  });
}

function cleanup(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, f), { force: true });
    }
    fs.rmdirSync(dir);
  } catch (_) { /* ignore */ }
}

function failResult(msg, base = {}) {
  return { ...base, tests: 0, pass: 0, fail: 0, skipped: 0, failures: [], coverage: null, stdout: msg, timedOut: false };
}

/** 从失败诊断里提取源码位置提示（file:line），帮学生快速定位到自己的代码行 */
function extractHints(errorText) {
  const hints = [];
  const seen = new Set();
  const re = /([\w.\-\/]+\.(?:js|mjs|cjs)):(\d+)(?::\d+)?/g;
  let m;
  while ((m = re.exec(String(errorText || ''))) && hints.length < 5) {
    const key = m[1] + ':' + m[2];
    if (/node:(internal|test)|node_modules/.test(m[1])) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push(key);
  }
  return hints;
}

/** 解析 node:test 的 TAP 输出 */
function parseTap(text, code, timedOut, durationMs) {
  const lines = String(text || '').split(/\r?\n/);
  let tests = 0, pass = 0, fail = 0, skipped = 0;
  const failures = [];
  const cases = [];
  let inDiag = false;
  let curFail = null;

  for (const line of lines) {
    let m;
    if ((m = /^# (tests|suites) (\d+)$/.exec(line.trim()))) tests = Math.max(tests, Number(m[2]));
    else if ((m = /^# pass (\d+)$/.exec(line.trim()))) pass = Number(m[1]);
    else if ((m = /^# fail (\d+)$/.exec(line.trim()))) fail = Number(m[1]);
    else if ((m = /^# (skipped|cancelled) (\d+)$/.exec(line.trim()))) skipped = Math.max(skipped, Number(m[2]));
    else if ((m = /^not ok \d+ - (.+)$/.exec(line.trim()))) {
      const name = m[1].replace(/\s*# (SKIP|TODO).*$/i, '').trim();
      curFail = { name, error: '', hints: [] };
      failures.push(curFail);
      cases.push({ name, ok: false, skipped: /# (SKIP|TODO)/i.test(m[1]) });
      inDiag = true;
    } else if ((m = /^ok \d+ - (.+)$/.exec(line.trim()))) {
      const name = m[1].replace(/\s*# (SKIP|TODO).*$/i, '').trim();
      cases.push({ name, ok: true, skipped: /# (SKIP|TODO)/i.test(m[1]) });
      inDiag = false;
      curFail = null;
    } else if (inDiag && curFail) {
      if (/^\s{4}/.test(line) || /error:|expected|actual/i.test(line)) {
        curFail.error += line.trim() + '\n';
        if (curFail.error.length > 800) curFail.error = curFail.error.slice(0, 800) + '…';
      }
    }
  }
  // 失败用例附源码行号提示（从堆栈里提取学生自己文件的位置）
  for (const f of failures) f.hints = extractHints(f.error + '\n' + String(text || ''));
  // 兜底：TAP 未输出统计（如进程被杀 / 语法错误）
  if (!tests && !pass && !fail) {
    const okCount = (String(text).match(/^ok \d+ - /gm) || []).length;
    const notOkCount = (String(text).match(/^not ok \d+ - /gm) || []).length;
    pass = okCount; fail = notOkCount; tests = okCount + notOkCount;
  }
  if (timedOut) {
    return {
      ok: false, timedOut: true, tests, pass, fail, skipped,
      cases: cases.slice(0, 100),
      failures: [{ name: '执行超时', error: `测试未在限定时间内完成（已强制终止）。检查是否存在死循环或未结束的异步等待。`, hints: [] }],
      coverage: null,
      stdout: head(text, 2000), durationMs,
    };
  }
  return {
    ok: code === 0 && fail === 0,
    timedOut: false,
    tests, pass, fail, skipped,
    cases: cases.slice(0, 100),
    failures: failures.slice(0, 20),
    coverage: parseCoverage(text),
    stdout: head(text, 4000),
    durationMs,
  };
}

/** 从 TAP 注释里解析覆盖率表（node --experimental-test-coverage） */
function parseCoverage(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|\s*(\d+(?:\.\d+)?)\s*\|(.*)$/.exec(line);
    if (m && !/file|all files/i.test(m[1])) {
      rows.push({ file: m[1].trim(), linePercent: Number(m[2]), branchPercent: Number(m[3]), funcPercent: Number(m[4]), uncovered: m[5].trim() });
    }
  }
  if (!rows.length) return null;
  const total = rows.find((r) => /all files/i.test(r.file));
  return {
    totalLinePercent: total ? total.linePercent : null,
    files: rows,
    note: '覆盖率是结果不是目标——先把失败的原因弄清楚，再谈百分比（FR-204 解读引导）。',
  };
}

function head(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** 留痕 */
function logRun({ studentId, groupId, sessionId, ok, summary }) {
  const id = uid('run');
  db.insert('tool_runs', {
    run_id: id,
    tool: 'unittest',
    student_id: studentId || null,
    group_id: groupId || null,
    session_id: sessionId || null,
    ok: ok === false ? 0 : 1,
    summary: summary || {},
    created_at: now(),
  });
  return id;
}

module.exports = { runTests, logRun, DEFAULT_TIMEOUT_MS };
