/**
 * 应用服务守护进程
 * 作用：常驻运行 server/index.js；异常退出自动重启；日志写入 .server.log。
 * 特点：独立进程（detached）运行，不随终端/对话结束而终止。
 *
 * 用法：node scripts/app-supervisor.js
 * 停止：创建 data/app.stop 文件，或结束该 node 进程
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, '.server.log');
const STOP_FILE = path.join(ROOT, 'data', 'app.stop');
const PID_FILE = path.join(ROOT, 'data', 'app.pid');

let child = null;
let backoff = 1000;
const MAX_BACKOFF = 30000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  try { process.stdout.write(line); } catch (_) {}
}

function start() {
  if (fs.existsSync(STOP_FILE)) {
    log('检测到 stop 标记，服务守护退出');
    process.exit(0);
  }

  log('启动应用服务…');
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: Object.assign({}, process.env),
  });

  const pipe = (d) => {
    try { fs.appendFileSync(LOG_FILE, d.toString()); } catch (_) {}
  };
  child.stdout.on('data', pipe);
  child.stderr.on('data', pipe);

  child.on('exit', (code, signal) => {
    log(`应用服务退出 code=${code} signal=${signal}，${Math.round(backoff / 1000)}s 后重启`);
    child = null;
    if (fs.existsSync(STOP_FILE)) process.exit(0);
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  });

  child.on('error', (err) => {
    log(`启动失败: ${err.message}`);
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  });

  // 连续稳定运行 60s 后重置退避
  setTimeout(() => { if (child) backoff = 1000; }, 60000);
}

try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch (_) {}
try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch (_) {}

log('==== 应用服务守护进程启动 ====');
start();
process.on('uncaughtException', (e) => log(`未捕获异常: ${e.message}`));
