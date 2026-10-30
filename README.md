# 知途伴学 zhitu

基于 AI 智能体的全天候伴随式导学系统（软件工程课程场景）。**零第三方依赖**，Node 内置 `node:http` + `node:sqlite`，复制即跑，便于校内私有化部署。

## 运行

```bash
# Node ≥ 22.5（用到 node:sqlite）
node server/index.js
# 或
npm start
```

- 地址：http://localhost:3000　健康检查：`GET /api/v1/health`
- 演示账号（密码统一 `123456`）：`teacher` 教师 / `ta` 助教 / `s001` 学生 / `admin` 管理员
- 端口可用 `PORT` 覆盖；`ZHITU_LOG=all` 打印全部请求日志

## 常用命令

| 命令 | 说明 |
|---|---|
| `npm run seed` | 初始化演示数据（含 M2 Git / M3 团队协同演示数据） |
| `npm run reset` | 重置数据库 |
| `npm test` | 全量测试（guard + smoke + tools + m3） |
| `npm run test:smoke` | 端到端冒烟（27 项） |
| `npm run test:guard` | 防代做专项（9 项） |
| `node tests/tools.js` | M2 工具层专项（36 项：静态检查 / 单测执行 / Git 轨迹 / M2 深化） |
| `node tests/m3.js` | M3 专项（35 项：站会 / 角色扮演 / 互评 / 复盘 / 推送 / 多端同步 / 成本） |
| `npm run verify:llm` | 验证大模型是否真的生效（看 VERDICT） |

## M2 工具层（2026-10-06 起，2026-10-11 深化）

| 能力 | 入口 | 红线 |
|---|---|---|
| 静态检查（15 条规则，分 error/warn/info） | 学生端「工具箱」；编码/测试阶段贴代码块时对话内自动附加摘要 | 只给问题清单 + 规范条目，不给修复代码（FR-104 ④） |
| 单测执行（node:test 沙箱） | 学生端「工具箱」 | 只运行与报告，不代写测试文件（FR-204）；硬超时 15s |
| Git 提交轨迹分析 | 教师端「提交轨迹」：登记 Gitea/GitLab/GitHub 只读仓库同步，或手工导入 git log | 只读同步；成员分布只列事实不评分；OBE「过程性提交频次」优先走真实 Git 数据，间隔方差计入口径 |

### M2 深化（2026-10-11）
- **静态检查**：规则 7→15 条（新增松散相等 / var / 空 catch / eval / alert / 魔法数字 / 长参数 / 重名函数）；问题带**行列号**；学生可按规则**降噪**（`disabled` 参数）；`GET /api/v1/tools/static-rules` 暴露规则目录与规范依据
- **单测执行**：逐用例明细（`cases`：名称/通过/跳过）；失败用例附**源码行号提示**（`hints`，从堆栈提取学生自己文件的 file:line）
- **Git 分析**：提交信息规范分析（类型分布 + Conventional Commits 符合率 + 低信息明细）；**24 小时时段直方图**与深夜占比；成员明细（活跃天/首末提交/次活跃日/增删行）；**日期区间筛选**（`from`/`to`）；新增节奏信号（深夜赶工 / 单日突击）；`GET /api/v1/teacher/git/report` 导出 Markdown 分析报告
- 教师端「提交轨迹」新增组详情（逐人卡片 + 时段柱状图 + 提交明细）；学生端工具箱/轨迹视图同步细化

## M3 全量版（2026-10-09 起）

| 能力 | 入口 | 红线/边界 |
|---|---|---|
| 站会助手（FR-301） | 学生端「团队协作」；提示基于本组 Git 事实生成 | 不代填记录；阻碍 100% 转待办并同步教师；空泛回答被追问 |
| 角色扮演（FR-302） | 学生端「团队协作」：PO / 客户 / 评委 | 角色坚持模糊不交需求文档；结束必给 ≥2 条改进建议的观察反馈 |
| 贡献度互评（FR-303） | 学生端「团队协作」 | 只给事实清单与引导问题；评语含打分/排名意图直接拒绝 |
| 小组复盘（FR-206） | 学生端「团队协作」三栏 | 正文学生自写；系统只聚合成长档案与补学清单；行动项自动入待办 |
| 周报（FR-403） | `GET /api/v1/student/weekly`、`GET /api/v1/teacher/weekly` | 教师版班级聚合，不含单条对话原文 |
| 推送通道（FR-503/507） | 教师端「推送与成本」：企微群机器人 Webhook + 站内降级 | 全量留痕 push_logs；失败不中断只留痕；预警扫描自动推送 |
| 多端接入（FR-404） | `public/mobile.html`（H5 轻客户端）+ `/api/v1/open/*`（设备令牌、增量同步、离线补收、VS Code 代码上下文） | 端仅渲染，会话统一服务；同步范围仅限本人 |
| 成本治理（FR-702） | 教师端「推送与成本」用量看板；`ZHITU_MODEL_DAILY_CAP` 配额 | 超配额自动降级规则引擎，导学不断线 |

## 结构

```
server/core/     orchestrator 调度 · pipeline 主链路 · tutor 导学 · levelMachine 层级
                 guardrail 护栏 · redline 红线 · policy 封顶 · alerts 预警 · metrics 指标
                 knowledge 图谱 · profile 画像 · stages/ 六阶段 · llm/ 模型与提示词
                 tools/  M2 工具层：git 轨迹 · staticCheck 静态检查 · unitTest 单测执行
                 team    M3 团队协同：站会 · 角色扮演 · 互评 · 复盘 · 周报
                 push    M3 推送渠道（企微 Webhook + 站内降级）
                 sync    M3 多端同步（设备令牌 + seq 游标增量）
                 cost    M3 成本治理（用量看板 + 每日配额）
server/routes/   auth · student · teacher · admin · tools · team · open · push
server/db/       schema.sql（36 表）· seed.js
public/          index · student · teacher · admin · mobile 五个页面
data/            zhitu.db（SQLite）· llm.json（模型配置）· test.db（测试库）
tests/           测试脚本 + _*_report.txt 报告
```

## 改动前必读

1. 主链路在 `server/core/pipeline.js`：上下文 → 意图 → 层级决策 → RAG → 导学 → 护栏 → 红线 → 留痕。
2. 层级状态机 `levelMachine.js`：默认 L0，受封顶拦截，24h 内同卡点再求助从上次层级 −1 起步。
3. 护栏双保险：模型层 `guardrail.js` 打回重写 + 规则层 `redline.js` 硬拦截，两层都要写原因码。
4. `server/index.js` 里的**模型预热不要删**——网关冷启动可达 20–33 秒，不预热会让第一个学生踩到超时降级。
5. 系统不代做、不作弊判定，这两条红线详见上级目录的《知途伴学-项目交接与续接指南.md》第 4 节。

完整需求与验收标准见：`../知途伴学-功能需求规格说明书.html`
使用说明见：`../知途伴学-系统使用说明书.html`
