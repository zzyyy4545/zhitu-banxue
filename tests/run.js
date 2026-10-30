'use strict';
/**
 * 测试运行器：自行拉起服务 → 等待就绪 → 执行测试 → 关闭服务
 * 不依赖 shell 的 sleep / 后台任务管理，避免进程被回收导致误判。
 * 用法：node tests/run.js [guard|smoke|all]
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;
const PORT = process.env.PORT || 3100; // 测试用独立端口，避免与开发实例冲突
const BASE = `http://127.0.0.1:${PORT}`;

const target = process.argv[2] || 'all';
const scripts = target === 'all' ? ['guard', 'smoke', 'tools', 'm3'] : [target];

function startServer() {
  const logFile = path.join(ROOT, '_server.log');
  const fd = fs.openSync(logFile, 'w');
  const p = spawn(NODE, ['--no-warnings', 'server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), ZHITU_LOG: process.env.ZHITU_LOG || '0' },
    stdio: ['ignore', fd, fd],
  });
  p.on('error', (e) => console.error('服务启动失败：', e.message));
  return { proc: p, fd };
}

async function waitReady(timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(BASE + '/api/v1/health', { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch (_) {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function runScript(name) {
  return new Promise((resolve) => {
    const p = spawn(NODE, ['--no-warnings', `tests/${name}.js`], {
      cwd: ROOT,
      env: { ...process.env, ZHITU_BASE: BASE, ZHITU_VERBOSE: process.env.ZHITU_VERBOSE || '0' },
      stdio: 'inherit',
    });
    p.on('exit', (code) => resolve(code === 0));
    p.on('error', () => resolve(false));
  });
}

(async () => {
  console.log('== 启动测试服务 ==');
  const { proc, fd } = startServer();
  const ready = await waitReady();
  if (!ready) {
    console.error('服务未在 20s 内就绪，查看 _server.log');
    proc.kill('SIGKILL');
    try { fs.closeSync(fd); } catch (_) {}
    process.exit(1);
  }
  console.log(`服务就绪：${BASE}`);

  let allPass = true;
  for (const s of scripts) {
    console.log(`\n== 执行 ${s}.js ==`);
    const ok = await runScript(s);
    console.log(`== ${s}.js ${ok ? '通过' : '存在失败项'} ==`);
    if (!ok) allPass = false;
  }

  proc.kill('SIGKILL');
  try { fs.closeSync(fd); } catch (_) {}
  console.log(`\n== 总体结果：${allPass ? '全部通过' : '存在失败项'} ==`);
  process.exit(allPass ? 0 : 1);
})();
