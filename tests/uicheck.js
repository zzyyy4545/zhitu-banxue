'use strict';
/**
 * 前端页面脚本执行检查（无浏览器）
 *
 * 目的：拦截「调用了未定义的函数」这类只在浏览器里才暴露的运行时错误
 * （典型如 student.html 调用 renderTrace() 但函数未定义，导致登录后整页不渲染）。
 *
 * 做法：用 vm 沙箱 + 最小 DOM stub 真实执行 public/*.html 的内联脚本，
 * fetch 转发到本地服务，登录态写入 localStorage stub；
 * 捕获两类信号：① ZT.toast(...,'err') 的错误提示 ② 未处理的 Promise 异常。
 *
 * 用法：先启动服务，再 node tests/uicheck.js
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PUB = path.join(ROOT, 'public');
const BASE = process.env.ZHITU_BASE || 'http://127.0.0.1:3000';

/** 页面 → 演示账号（index.html 为登录页，无需登录） */
const PAGE_USER = { 'student.html': 's001', 'teacher.html': 'teacher', 'admin.html': 'admin' };

function makeEl(tag, id) {
  return {
    tagName: tag, id: id || '', innerHTML: '', textContent: '', value: '', href: '', download: '',
    style: {}, dataset: {}, children: [], scrollTop: 0, scrollHeight: 0, offsetHeight: 0,
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { if (f) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); },
    },
    appendChild(c) { this.children.push(c); return c; },
    removeChild() {}, remove() {}, setAttribute() {}, getAttribute() { return null; },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll() { return []; }, querySelector() { return null; },
    closest() { return null; }, click() {}, focus() {}, scrollIntoView() {},
  };
}

function makeSandbox() {
  const els = new Map();
  const document = {
    getElementById(id) {
      if (!els.has(id)) els.set(id, makeEl('div', id));
      return els.get(id);
    },
    createElement(tag) { return makeEl(tag); },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    addEventListener() {},
    body: makeEl('body'),
    head: makeEl('head'),
  };
  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, AbortSignal, AbortController,
    fetch: (u, init) => fetch(String(u).startsWith('http') ? u : BASE + u, init),
    document, localStorage,
    location: { href: '', search: '', pathname: '' },
    navigator: { userAgent: 'node-uicheck' },
    Blob, URL, JSON, Math, Date, Promise, Error, TypeError, ReferenceError,
    Object, Array, String, Number, Boolean, RegExp, Map, Set, Symbol,
    encodeURIComponent, decodeURIComponent, isNaN, parseInt, parseFloat,
    __errors: [],
  };
  URL.createObjectURL = () => 'blob:uicheck';
  URL.revokeObjectURL = () => {};
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

function extractScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (/\bsrc\s*=/.test(m[1] || '')) continue;
    out.push(m[2]);
  }
  return out;
}

async function login(username) {
  const r = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: '123456' }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`登录失败 ${username}: ${d.error || r.status}`);
  return d;
}

const rejections = [];
process.on('unhandledRejection', (e) => rejections.push(String((e && e.message) || e)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const lines = [];
  const appjs = fs.readFileSync(path.join(PUB, 'assets', 'app.js'), 'utf8');
  let fail = 0;

  for (const f of ['index.html', 'student.html', 'teacher.html', 'admin.html']) {
    const file = path.join(PUB, f);
    if (!fs.existsSync(file)) continue;
    const code = extractScripts(fs.readFileSync(file, 'utf8')).join('\n');
    const sandbox = makeSandbox();
    rejections.length = 0;

    try {
      vm.runInContext(appjs, sandbox, { filename: 'app.js' });
    } catch (e) {
      lines.push(`[FATAL] ${f} 加载 app.js 失败：${e.message}`);
      fail++;
      continue;
    }
    // 接管错误提示：页面里 catch 后通常只做 toast，需在此捕获
    const realToast = sandbox.ZT.toast;
    sandbox.ZT.toast = (m, k) => {
      if (k === 'err') sandbox.__errors.push(String(m));
      return realToast(m, k);
    };

    const user = PAGE_USER[f];
    if (user) {
      const d = await login(user);
      sandbox.localStorage.setItem('zhitu_token', d.token);
      sandbox.localStorage.setItem('zhitu_user', JSON.stringify(d.user));
    }

    let syncErr = null;
    try {
      vm.runInContext(code, sandbox, { filename: f });
    } catch (e) {
      syncErr = e.message;
    }
    await sleep(1500); // 等 boot() 的异步请求跑完

    const errs = [...sandbox.__errors, ...rejections];
    if (syncErr) errs.push('同步异常: ' + syncErr);
    const ok = errs.length === 0;
    if (!ok) fail++;
    lines.push(`${ok ? '[PASS]' : '[FAIL]'} ${f}${user ? '（' + user + '）' : ''}` +
      (errs.length ? '\n       ' + errs.join('\n       ') : ''));
  }

  lines.unshift('===== 前端页面脚本执行检查 =====');
  lines.push('');
  lines.push(fail === 0 ? '>>> 全部页面脚本执行无运行时错误' : `>>> ${fail} 个页面存在运行时错误`);
  const out = lines.join('\n');
  fs.writeFileSync(path.join(__dirname, '_uicheck.txt'), out, 'utf8');
  console.log(out);
  process.exit(fail === 0 ? 0 : 1);
})();
