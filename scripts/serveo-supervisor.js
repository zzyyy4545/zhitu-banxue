/**
 * serveo 固定子域名隧道守护进程
 * 作用：把本机 :3000（知途伴学前后端一体服务）通过 serveo.net 暴露为
 *       稳定公开地址 https://zhitu2026.serveo.net，断线自动重连。
 * 前提：.ssh/id_lhr 公钥已在 serveo.net 登录后注册（GitHub/Google 登录），
 *       否则 serveo 不会绑定 zhitu2026 这个自定义子域名。
 *
 * 用法：node scripts/serveo-supervisor.js
 * 停止：创建 data/serveo.stop，或结束该 node 进程
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOG_FILE = path.join(ROOT, 'data', 'serveo.log');
const STOP_FILE = path.join(ROOT, 'data', 'serveo.stop');
const PID_FILE = path.join(ROOT, 'data', 'serveo.pid');
const URL_FILE = path.join(ROOT, 'data', 'serveo-url.txt');

const KEY = path.join(ROOT, '.ssh', 'id_lhr');
const SUBDOMAIN = 'zhitu2026';
const REMOTE = 'serveo.net';

let child = null;
let backoff = 2000;
const MAX_BACKOFF = 60000;

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
  try { process.stdout.write(line); } catch (_) {}
}

function writeUrl(url) {
  try { fs.writeFileSync(URL_FILE, url, 'utf8'); } catch (_) {}
}

function start() {
  if (fs.existsSync(STOP_FILE)) {
    log('检测到 stop 标记，serveo 守护退出');
    process.exit(0);
  }

  log('建立 serveo 隧道（子域名 ' + SUBDOMAIN + '）…');
  child = spawn('ssh', [
    '-i', KEY,
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'UserKnownHostsFile=/dev/null',
    '-R', `${SUBDOMAIN}:80:localhost:3000`,
    REMOTE,
  ], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: Object.assign({}, process.env),
  });

  const onData = (d) => {
    const s = d.toString();
    try { fs.appendFileSync(LOG_FILE, s); } catch (_) {}
    // 优先抓取真实转发地址：Forwarding HTTP traffic from https://xxx
    const fwd = s.match(/Forwarding HTTP traffic from\s+(https?:\/\/\S+)/i);
    if (fwd) {
      const url = fwd[1].replace(/[\s."]$/, '');
      writeUrl(url);
      log('公网地址就绪: ' + url);
    }
    const needAuth = /not authorized|log in|authenticate|register/i.test(s);
    if (needAuth) log('提示：serveo 要求该子域名需登录后注册公钥，请先在 serveo.net 用 GitHub/Google 登录并添加本机公钥。');
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);

  child.on('exit', (code, signal) => {
    log(`serveo 隧道退出 code=${code} signal=${signal}，${Math.round(backoff / 1000)}s 后重连`);
    child = null;
    writeUrl('');
    if (fs.existsSync(STOP_FILE)) process.exit(0);
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  });

  child.on('error', (err) => {
    log(`启动失败: ${err.message}`);
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  });

  setTimeout(() => { if (child) backoff = 2000; }, 60000);
}

try { if (fs.existsSync(STOP_FILE)) fs.unlinkSync(STOP_FILE); } catch (_) {}
try { fs.writeFileSync(PID_FILE, String(process.pid), 'utf8'); } catch (_) {}
log('==== serveo 隧道守护进程启动 ====');
start();
process.on('uncaughtException', (e) => log(`未捕获异常: ${e.message}`));
