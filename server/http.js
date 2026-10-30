'use strict';
/**
 * 极简 Web 框架（零第三方依赖，基于 Node 内置 http）
 * 提供：路由（含 :param）、中间件链、JSON body 解析、静态文件、CORS
 * 仅覆盖本项目所需能力，不追求通用性。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function compilePath(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp('^' + source + '/?$'), keys };
}

class Response {
  constructor(res) {
    this.raw = res;
  }
  status(code) {
    this.raw.statusCode = code;
    return this;
  }
  header(k, v) {
    this.raw.setHeader(k, v);
    return this;
  }
  json(body, code) {
    // 若已通过 status() 设置过状态码且未显式传入 code，则沿用之，
    // 否则默认的 200 会覆盖 statusCode，导致错误响应被客户端判定为成功
    const c = code || this.raw.statusCode || 200;
    const buf = Buffer.from(JSON.stringify(body), 'utf8');
    this.raw.writeHead(c, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    });
    this.raw.end(buf);
  }
  text(body, code) {
    const c = code || this.raw.statusCode || 200;
    const buf = Buffer.from(String(body), 'utf8');
    this.raw.writeHead(c, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': buf.length,
    });
    this.raw.end(buf);
  }
  send(buffer, type, code = 200) {
    this.raw.writeHead(code, {
      'Content-Type': type,
      'Content-Length': buffer.length,
    });
    this.raw.end(buffer);
  }
  download(filename, buffer, type = 'application/octet-stream') {
    this.raw.writeHead(200, {
      'Content-Type': type,
      'Content-Length': buffer.length,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    this.raw.end(buffer);
  }
}

function createApp() {
  const routes = [];
  const mws = [];

  function add(method, pattern, ...handlers) {
    routes.push({ method, ...compilePath(pattern), handlers });
  }

  const app = {
    use(fn) {
      mws.push(fn);
      return app;
    },
    get: (p, ...h) => add('GET', p, ...h),
    post: (p, ...h) => add('POST', p, ...h),
    put: (p, ...h) => add('PUT', p, ...h),
    patch: (p, ...h) => add('PATCH', p, ...h),
    delete: (p, ...h) => add('DELETE', p, ...h),
    routes,
    listen(port, host = '0.0.0.0') {
      const server = http.createServer(handler);
      return new Promise((resolve) => {
        server.listen(port, host, () => resolve(server));
      });
    },
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const limit = 4 * 1024 * 1024; // 4MB
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new Error('PAYLOAD_TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        const ct = (req.headers['content-type'] || '').toLowerCase();
        if (ct.includes('application/json')) {
          try {
            return resolve(JSON.parse(raw));
          } catch (e) {
            return reject(new Error('BAD_JSON'));
          }
        }
        resolve({ __raw: raw });
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, rootDir) {
    let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (rel === '/' || rel === '') rel = '/index.html';
    const full = path.join(rootDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(path.resolve(rootDir))) {
      res.statusCode = 403;
      return res.end('Forbidden');
    }
    fs.stat(full, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('Not Found: ' + rel);
      }
      const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': st.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(full).pipe(res);
    });
  }

  const handler = async (req, res) => {
    const url = new URL(req.url, 'http://x');
    req.path = url.pathname;
    req.query = Object.fromEntries(url.searchParams.entries());
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const wrapped = new Response(res);
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        req.body = await readBody(req);
      }
    } catch (e) {
      return wrapped.status(413).json({ error: e.message });
    }

    // 中间件
    for (const mw of mws) {
      try {
        const r = await mw(req, wrapped);
        if (r === false || res.writableEnded) return;
      } catch (e) {
        return wrapped.status(e.status || 500).json({ error: e.message });
      }
    }

    // 路由
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(req.path);
      if (!m) continue;
      req.params = {};
      r.keys.forEach((k, i) => {
        req.params[k] = decodeURIComponent(m[i + 1]);
      });
      // 依次执行守卫与业务 handler：
      // 返回 false → 交棒下一个；返回值 → 直接 JSON 响应；
      // 返回 undefined 且未响应 → 继续执行下一个 handler（守卫通过后必须落到业务 handler）
      for (const h of r.handlers) {
        try {
          const out = await h(req, wrapped);
          if (out === false) continue;
          if (out !== undefined && !res.writableEnded) return wrapped.json(out);
          if (res.writableEnded) return;
        } catch (e) {
          return wrapped.status(e.status || 500).json({ error: e.message });
        }
      }
      if (res.writableEnded) return;
      if (req.method === 'GET' && app.staticDir) return serveStatic(req, res, app.staticDir);
      return wrapped.status(404).json({ error: 'NOT_FOUND', path: req.path });
    }

    // 兜底：静态文件
    if (req.method === 'GET' && app.staticDir) {
      return serveStatic(req, res, app.staticDir);
    }
    wrapped.status(404).json({ error: 'NOT_FOUND', path: req.path });
  };

  app.static = (dir) => {
    app.staticDir = dir;
    return app;
  };
  return app;
}

module.exports = { createApp };
