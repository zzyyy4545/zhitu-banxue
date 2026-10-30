/* 知途伴学 · 前端共享工具 */
(function (global) {
  'use strict';

  const LEVELS = ['L0 提示反问', 'L1 方向指引', 'L2 步骤拆解', 'L3 局部示例', 'L4 完整讲解'];
  const LEVEL_BRIEF = ['提示反问', '方向指引', '步骤拆解', '局部示例', '完整讲解'];

  const TOKEN_KEY = 'zhitu_token';
  const USER_KEY = 'zhitu_user';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }
  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
  function getUser() {
    try {
      return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + getToken(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    const text = await res.text();
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { __raw: text };
    }
    if (res.status === 401) {
      clearSession();
      location.href = 'index.html';
      throw new Error('登录已过期');
    }
    if (!res.ok) throw new Error((data && data.error) || '请求失败 ' + res.status);
    return data;
  }
  const get = (u) => api('GET', u);
  const post = (u, b) => api('POST', u, b || {});
  const put = (u, b) => api('PUT', u, b || {});
  const del = (u) => api('DELETE', u);

  /** 登录守卫：角色不匹配时跳转 */
  function guard(roles) {
    const u = getUser();
    if (!u || !getToken()) {
      location.href = 'index.html';
      return null;
    }
    if (roles && !roles.includes(u.role)) {
      location.href = 'index.html?err=role';
      return null;
    }
    return u;
  }

  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** 轻量富文本：保留换行，标记 **加粗** */
  function fmt(s) {
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/\n/g, '<br>');
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
    if (diff < 86400 * 7) return Math.floor(diff / 86400) + ' 天前';
    return String(iso).slice(0, 10);
  }

  function ts(iso) {
    return iso ? String(iso).slice(0, 16).replace('T', ' ') : '';
  }

  /** 渲染顶部栏 */
  function topbar(title, user, extraPills) {
    const el = document.getElementById('topbar');
    if (!el) return;
    const roleName = { student: '学生', leader: '组长', ta: '助教', teacher: '教师', admin: '管理员' }[user.role] || user.role;
    el.innerHTML =
      '<div class="logo">知</div>' +
      '<h1>' + esc(title) + '</h1>' +
      (extraPills || '') +
      '<div class="sp"></div>' +
      '<span class="who">' + esc(user.name || user.username) + ' · ' + roleName + '</span>' +
      '<button class="btn gh sm" id="btn-logout">退出</button>';
    const lo = document.getElementById('btn-logout');
    if (lo) lo.onclick = () => { clearSession(); location.href = 'index.html'; };
  }

  /** 标签页切换 */
  function tabs(containerId, onChange) {
    const box = document.getElementById(containerId);
    if (!box) return;
    box.addEventListener('click', (e) => {
      const t = e.target.closest('.tab');
      if (!t) return;
      [...box.querySelectorAll('.tab')].forEach((x) => x.classList.remove('on'));
      t.classList.add('on');
      const key = t.dataset.tab;
      document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + key));
      if (onChange) onChange(key);
    });
  }

  function toast(msg, kind) {
    let el = document.getElementById('toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'toast';
      el.style.cssText =
        'position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:999;padding:10px 18px;border-radius:10px;' +
        'background:#2C2C2A;color:#fff;font-size:13px;box-shadow:0 4px 16px rgba(0,0,0,.15);display:none;max-width:80vw';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.style.background = kind === 'err' ? '#A32D2D' : kind === 'ok' ? '#3B6D11' : '#2C2C2A';
    el.style.display = 'block';
    clearTimeout(el.__t);
    el.__t = setTimeout(() => (el.style.display = 'none'), 2600);
  }

  function downloadText(filename, text, mime) {
    const b = new Blob([text], { type: (mime || 'text/plain') + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 100);
  }

  global.ZT = {
    LEVELS, LEVEL_BRIEF,
    getToken, setSession, clearSession, getUser,
    api, get, post, put, del,
    guard, esc, fmt, timeAgo, ts, topbar, tabs, toast, downloadText,
  };
})(window);
