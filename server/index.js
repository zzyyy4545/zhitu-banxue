'use strict';
/**
 * 知途伴学 · 服务入口
 * 零第三方依赖：Web 层用 Node 内置 http，数据层用 Node 内置 node:sqlite
 */
const path = require('node:path');
const fs = require('node:fs');
const db = require('./db');

// 崩溃捕获：服务意外退出时留下线索，便于私有化部署现场排查
const CRASH_LOG = path.join(__dirname, '..', '_crash.log');
const logCrash = (kind, e) => {
  try {
    fs.appendFileSync(
      CRASH_LOG,
      `[${new Date().toISOString()}] ${kind}: ${(e && e.stack) || e}\n`,
      'utf8'
    );
  } catch (_) {
    /* ignore */
  }
};
process.on('uncaughtException', (e) => logCrash('uncaughtException', e));
process.on('unhandledRejection', (e) => logCrash('unhandledRejection', e));
const { createApp } = require('./http');
const alerts = require('./core/alerts');
const redline = require('./core/redline');
const prompts = require('./core/llm/prompts');
const llm = require('./core/llm');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

async function main() {
  db.initSchema();
  // 云托管自愈：临时盘重置后库为空（如 Render 免费层休眠/重启），
  // 自动播种演示账号与基础数据；已存在则跳过，本地已有数据不受影响。
  try {
    const u = db.get('SELECT COUNT(*) AS c FROM users');
    if (!u || Number(u.c) === 0) {
      console.log('[seed] 检测到空库，自动播种演示数据…');
      require('./db/seed').main();
    }
  } catch (_) {
    /* users 表尚未就绪时忽略，下一轮启动重试 */
  }
  redline.ensureDefaults();
  prompts.ensureDefaults();
  alerts.ensureRuleDefaults(); // M4：预警规则入库（FR-503 阈值可配置）

  const app = createApp();
  app.static(PUBLIC_DIR);

  // 请求日志（7 非功能性需求：可观测性）。ZHITU_LOG=all 打印全部，默认仅打印慢请求
  if (process.env.ZHITU_LOG !== '0') {
    app.use((req, res) => {
      const t0 = Date.now();
      res.raw.on('finish', () => {
        const ms = Date.now() - t0;
        if (ms > 500 || process.env.ZHITU_LOG === 'all') {
          console.log(`[req] ${req.method} ${req.path} → ${res.raw.statusCode} ${ms}ms`);
        }
      });
    });
  }

  // 路由
  require('./routes/auth')(app);
  require('./routes/student')(app);
  require('./routes/teacher')(app);
  require('./routes/admin')(app);
  require('./routes/tools')(app);
  require('./routes/team')(app);   // M3：团队协同（站会/角色扮演/互评/复盘/周报）
  require('./routes/open')(app);   // M3：多端开放接口（设备注册 + 增量消息同步）
  require('./routes/push')(app);   // M3：推送渠道 + 成本看板

  // 健康检查（7 非功能性需求：可观测性）
  app.get('/api/v1/health', (req, res) => {
    res.json({
      ok: true,
      ts: new Date().toISOString(),
      counts: {
        students: db.count('students'),
        helpEvents: db.count('help_events'),
        alerts: db.count('alerts', "status='pending'"),
      },
    });
  });

  // 定时任务：每小时扫描一次预警（生产可换 cron）
  const SCAN_INTERVAL_MS = Number(process.env.ZHITU_SCAN_MS || 3600000);
  const push = require('./core/push');
  setInterval(() => {
    try {
      const r = alerts.scan();
      if (r.created) {
        console.log(`[alerts] 扫描新增 ${r.created} 条预警`);
        // M3（FR-503）：新预警同步推送到所有启用渠道（企业微信 + 站内），失败仅留痕不中断
        for (const id of r.alertIds) {
          const a = db.get('SELECT * FROM alerts WHERE alert_id=?', [id]);
          if (a) push.notifyAlert(a).catch(() => {});
        }
      }
    } catch (e) {
      console.error('[alerts] 扫描失败：', e.message);
    }
  }, SCAN_INTERVAL_MS).unref?.();

  await app.listen(PORT);
  const url = `http://localhost:${PORT}`;

  /**
   * 模型预热（后台异步，不阻塞启动）：
   * 网关首次调用某个模型需要加载，实测首个请求可达 20s 并因此超时降级回规则引擎。
   * 启动后先跑一次最小对话把模型拉热，避免第一个上课的学生踩到冷启动。
   */
  if (llm.isEnabled()) {
    setTimeout(() => {
      llm.testConnection({ strongModel: llm.rawConfig().lightModel })
        .then((r) => console.log(`[llm] 预热${r.ok ? '完成' : '失败'}：${r.model || '-'} ${r.latencyMs}ms${r.error ? ' · ' + r.error : ''}`))
        .catch((e) => console.log('[llm] 预热异常：' + e.message));
    }, 500).unref?.();
  }

  console.log('');
  console.log('  知途伴学 · 服务已启动');
  console.log('  ─────────────────────────────────────');
  console.log(`  地址：${url}`);
  console.log(`  数据库：${db.DB_FILE}`);
  console.log('  账号：teacher/123456（教师） ta/123456（助教） s001/123456（学生） admin/123456（管理员）');
  console.log('');
}

main().catch((e) => {
  console.error('启动失败：', e);
  process.exit(1);
});
