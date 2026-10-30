'use strict';
/**
 * 大模型接入连通性检查（不需要启动服务）
 * 用法：node tests/llmcheck.js
 * 读取 data/llm.json（或环境变量）后：① 拉取网关模型清单 ② 跑一次最小对话
 * 用于确认：地址对不对、Key 有没有权限、模型 ID 到底填什么。
 */
const path = require('node:path');
const fs = require('node:fs');
const llm = require('../server/core/llm');

const OUT = path.join(__dirname, '_llmcheck.txt');

(async () => {
  const cfg = llm.rawConfig();
  const lines = [];
  lines.push('===== 大模型接入检查 =====');
  lines.push('配置文件：' + llm.CONFIG_FILE + (fs.existsSync(llm.CONFIG_FILE) ? '（存在）' : '（不存在，使用默认值/环境变量）'));
  lines.push('接口地址：' + (cfg.baseUrl || '（未配置）'));
  lines.push('解析后的接口前缀：' + (llm.apiBase(cfg.baseUrl, cfg.apiKey) || '（未配置）'));
  lines.push('API Key ：' + (cfg.apiKey ? '已配置（' + cfg.apiKey.slice(0, 6) + '***）' : '未配置'));
  lines.push('强模型 ：' + (cfg.strongModel || '（未配置，测试时取网关第一个模型）'));
  lines.push('轻量模型：' + (cfg.lightModel || '（未配置）'));
  lines.push('启用开关：' + (cfg.enabled ? '开' : '关') + ' · 超时 ' + cfg.timeoutMs + 'ms');
  lines.push('');

  if (!cfg.baseUrl || !cfg.apiKey) {
    lines.push('>>> 未配置接口地址或 API Key，跳过连通性测试。');
    lines.push('>>> 可在管理端「模型与成本」页填写，或直接编辑上述配置文件。');
    fs.writeFileSync(OUT, lines.join('\n'), 'utf8');
    console.log(lines.join('\n'));
    process.exit(1);
  }

  const r = await llm.testConnection();
  lines.push('连通性测试结果：' + (r.ok ? '成功' : '失败'));
  lines.push('耗时：' + r.latencyMs + 'ms · 使用模型：' + (r.model || '-'));
  if (r.ok) lines.push('模型回复样本：' + r.sample);
  if (r.error) lines.push('错误：' + r.error);
  lines.push('');
  lines.push('可用模型共 ' + r.modelCount + ' 个：');
  r.models.forEach((m) => lines.push('  - ' + m));
  lines.push('');
  lines.push(r.ok
    ? '>>> 接入正常。把「强模型」填为上面列表中的任意一个 ID 即可（轻量模型可填同一个或更便宜的）。'
    : '>>> 接入未通过，系统会继续用规则引擎，不影响教学演示。');

  const out = lines.join('\n');
  fs.writeFileSync(OUT, out, 'utf8');
  console.log(out);
  process.exit(r.ok ? 0 : 1);
})().catch((e) => {
  const msg = '检查脚本异常：' + e.message;
  fs.writeFileSync(OUT, msg, 'utf8');
  console.error(msg);
  process.exit(1);
});
