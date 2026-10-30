/**
 * 隧道守护进程
 * 作用：持续维持 localhost.run 反向隧道；进程退出后自动重连；
 *      把当前公网地址写入 data/public-url.txt，并记录日志 data/tunnel.log。
 * 特点：由独立进程运行（detached），不随对话/终端会话结束而终止。
 *
 * 用法：node scripts/tunnel-supervisor.js
 * 停止：删除 data/tunnel.stop 文件（或结束 node 进程）
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const URL_FILE = path.join(ROOT, 'data', 'public-url.txt');
const LOG_FILE = path.join(ROOT, 'data', 'tunnel.log');
const STOP_FILE = path.join(ROOT, 'data', 'tunnel.stop');
const PID_FILE = path.join(ROOT, 'data', 'tunnel.pid');

const SSH_KEY = path.join(ROOT, '.ssh', 'id_lhr');
const LOCAL_PORT = process.env.PORT || '3000';

let child = null;
let backoff = 2000;
const MAX_BACKOFF = 60000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch (_) {}
}

function shouldStop() {
  return fs.existsSync(STOP_FILE);
}

function publishUrl(url) {
  try {
    fs.mkdirSync(path.dirname(URL_FILE), { recursive: true });
    fs.writeFileSync(URL_FILE, url, 'utf8');
  } catch (_) {}
  log(`公网地址就绪: ${url}`);
}

function start() {
  if (shouldStop()) {
    log('检测到 stop 标记，守护进程退出');
    process.exit(0);
  }

  log('正在建立隧道…');
  child = spawn(
    'ssh',
    [
      '-i', SSH_KEY,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'UserKnownHostsFile=/dev/null',
      '-o', 'ServerAliveInterval=20',
      '-o', 'ServerAliveCountMax=3',
      '-o', 'ExitOnForwardFailure=yes',
      '-o', 'TCPKeepAlive=yes',
      '-R', `80:localhost:${LOCAL_PORT}`,
      'nokey@localhost.run',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
  );

  let buf = '';

  const onData = (chunk) => {
    const text = chunk.toString();
    buf += text;
    // localhost.run 会输出形如 https://xxxx.lhr.life 的地址
    const m = text.match(/https:\/\/[a-z0-9]+\.lhr\.life/gi);
    if (m && m.length) {
      const url = m[m.length - 1].toLowerCase();
      publishUrl(url);
      backoff = 2000; // 成功一次即重置退避
    }
  };

  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('exit', (code, signal) => {
    log(`隧道断开 code=${code} signal=${signal}，${Math.round(backoff / 1000)}s 后重连`);
    child = null;
    if (shouldStop()) {
      log('收到停止标记，不再重连');
      process.exit(0);
    }
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  });

  child.on('error', (err) => {
    log(`启动 ssh 失败: ${err.message}`);
    if (!child) setTimeout(start, backoff);
  });
}

// 清理旧标记
try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch (_) {}
try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch (_) {}

log('==== 隧道守护进程启动 ====');
start();

// 兜底：进程异常退出时也尝试重连（由系统服务/手动重启负责）
process.on('uncaughtException', (e) => log(`未捕获异常: ${e.message}`));
