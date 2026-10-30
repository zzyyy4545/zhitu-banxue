-- 知途伴学 · 数据库 Schema
-- 对齐《功能需求规格说明书 v1.0》5.1 核心实体
-- 约定：所有 *_at 字段存 ISO8601 字符串；所有 JSON 字段以 TEXT 存储

-- ============ 组织与账号 ============
CREATE TABLE IF NOT EXISTS classes (
  class_id    TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  course      TEXT DEFAULT '软件工程',
  teacher_id  TEXT,
  term        TEXT,
  created_at  TEXT
);

CREATE TABLE IF NOT EXISTS students (
  student_id  TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  class_id    TEXT,
  group_id    TEXT,
  role        TEXT DEFAULT 'student',      -- student / leader
  status      TEXT DEFAULT 'active',
  created_at  TEXT
);

-- 登录账号（学生/组长/助教/教师/管理员统一入口）
CREATE TABLE IF NOT EXISTS users (
  user_id     TEXT PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,               -- 演示用明文；生产应替换为哈希
  role        TEXT NOT NULL,               -- student / leader / ta / teacher / admin
  ref_id      TEXT,                        -- 对应 student_id 或 teacher_id
  name        TEXT,
  scope       TEXT,                        -- 助教/教师管辖范围：JSON {class_ids:[]}
  created_at  TEXT
);

CREATE TABLE IF NOT EXISTS groups (
  group_id      TEXT PRIMARY KEY,
  project_name  TEXT,
  sprint_no     INTEGER DEFAULT 1,
  current_stage TEXT DEFAULT 'requirements',
  class_id      TEXT,
  sprint_end    TEXT,
  created_at    TEXT
);

-- ============ 会话与消息 ============
CREATE TABLE IF NOT EXISTS sessions (
  session_id  TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL,
  stage       TEXT NOT NULL,               -- 项目阶段 key
  sprint_no   INTEGER DEFAULT 1,
  title       TEXT,
  node_id     TEXT,                        -- 当前导学剧本节点
  level       INTEGER DEFAULT 0,           -- 当前层级 L0-L4
  cap_level   INTEGER DEFAULT 2,           -- 本会话生效的封顶层快照
  event_id    TEXT,                        -- 当前求助事件
  draft       TEXT DEFAULT '{}',           -- 本会话已抽取的产出物草稿（JSON）
  channel     TEXT DEFAULT 'web',
  started_at  TEXT,
  last_at     TEXT,
  ended_at    TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  msg_id      TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL,               -- agent / student / system
  content     TEXT NOT NULL,
  level       INTEGER,                     -- 该条 agent 输出所用层级
  intent      TEXT,
  engine      TEXT,                        -- rule / llm
  prompt_ver  TEXT,
  model_ver   TEXT,
  guard       TEXT,                        -- pass / reject / downgrade
  created_at  TEXT
);

-- ============ 求助事件与产出物 ============
CREATE TABLE IF NOT EXISTS help_events (
  event_id      TEXT PRIMARY KEY,
  student_id    TEXT NOT NULL,
  session_id    TEXT,
  group_id      TEXT,
  stage         TEXT,
  node_id       TEXT,
  title         TEXT,
  knowledge_tags TEXT DEFAULT '[]',
  status        TEXT DEFAULT 'open',       -- open / resolved
  max_level     INTEGER DEFAULT 0,
  upgrade_count INTEGER DEFAULT 0,
  turn_count    INTEGER DEFAULT 0,
  opened_at     TEXT,
  closed_at     TEXT
);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id     TEXT PRIMARY KEY,
  group_id        TEXT,
  student_id      TEXT,
  stage           TEXT,
  type            TEXT,                    -- story / design / commit / test / demo / retro
  content         TEXT,                    -- JSON
  version         INTEGER DEFAULT 1,
  prev_version_id TEXT,
  knowledge_tags  TEXT DEFAULT '[]',
  created_at      TEXT
);

-- ============ 知识与画像 ============
CREATE TABLE IF NOT EXISTS knowledge_nodes (
  node_id       TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  parent_id     TEXT,
  level         INTEGER DEFAULT 1,         -- 图谱层级：1 一级 / 2 二级
  definition    TEXT,
  misconceptions TEXT DEFAULT '[]',
  resources     TEXT DEFAULT '[]',
  target_ids    TEXT DEFAULT '[]',
  keywords      TEXT DEFAULT '[]',
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS learner_profiles (
  student_id     TEXT PRIMARY KEY,
  base_level     TEXT DEFAULT '初学',       -- 初学 / 进阶
  prefer_style   TEXT DEFAULT '类比',
  progress       TEXT DEFAULT '{}',        -- JSON: {stage: percent}
  stuck_tags     TEXT DEFAULT '[]',
  level_distribution TEXT DEFAULT '{}',    -- JSON: {"0":n,"1":n,...}
  avg_turns      REAL DEFAULT 0,
  activity_pattern TEXT DEFAULT '{}',
  emotion_signals INTEGER DEFAULT 0,
  updated_at     TEXT
);

-- ============ 治理 ============
CREATE TABLE IF NOT EXISTS policies (
  policy_id   TEXT PRIMARY KEY,
  scope       TEXT NOT NULL,               -- global / class / group / task
  scope_id    TEXT,
  stage       TEXT,                        -- 为空表示不限阶段
  cap_level   INTEGER NOT NULL,            -- L1-L4，不允许「无限制」
  active_from TEXT,
  active_to   TEXT,
  updated_by  TEXT,
  updated_at  TEXT,
  note        TEXT
);

CREATE TABLE IF NOT EXISTS unlock_requests (
  req_id      TEXT PRIMARY KEY,
  student_id  TEXT NOT NULL,
  event_id    TEXT,
  target_level INTEGER NOT NULL,
  reason      TEXT,
  trace       TEXT,                        -- JSON: 层级轨迹
  approver_id TEXT,
  decision    TEXT,                        -- pending / approved / rejected / human
  decided_note TEXT,
  valid_until TEXT,
  created_at  TEXT,
  decided_at  TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  alert_id     TEXT PRIMARY KEY,
  target_type  TEXT,                       -- student / group
  target_id    TEXT,
  rule_id      TEXT,
  trigger_reason TEXT,
  suggest      TEXT,
  status       TEXT DEFAULT 'pending',     -- pending / handled / ignored
  handler_id   TEXT,
  created_at   TEXT,
  handled_at   TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id     TEXT PRIMARY KEY,
  actor_id   TEXT,
  actor_role TEXT,
  action     TEXT,
  target     TEXT,
  detail     TEXT,                         -- JSON
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS guardrail_logs (
  log_id     TEXT PRIMARY KEY,
  session_id TEXT,
  student_id TEXT,
  stage      TEXT,
  level      INTEGER,
  result     TEXT,                         -- pass / reject / downgrade
  reason_code TEXT,
  detail     TEXT,
  engine     TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS outreach_logs (
  id         TEXT PRIMARY KEY,
  student_id TEXT,
  rule_id    TEXT,
  channel    TEXT DEFAULT 'inbox',
  sent_at    TEXT
);

-- OBE：教师答疑工时（自报 + 系统估算）
CREATE TABLE IF NOT EXISTS teacher_worklog (
  id         TEXT PRIMARY KEY,
  teacher_id TEXT,
  minutes    INTEGER DEFAULT 0,
  category   TEXT,                         -- manual / alert / review
  source     TEXT DEFAULT 'self',          -- self / system
  note       TEXT,
  created_at TEXT
);

-- FR-108 答案红线规则库（可配置、可热更新）
CREATE TABLE IF NOT EXISTS redline_rules (
  rule_id    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,               -- regex / code_lines / count / doc_struct
  param      TEXT DEFAULT '{}',           -- JSON: 依 kind 而定
  stage      TEXT,                        -- 为空表示全阶段
  max_level  INTEGER DEFAULT 3,           -- 生效层级上限：仅当当前层级 <= max_level 时拦截（L4 放行）
  reason_code TEXT NOT NULL,
  replacement TEXT,
  enabled    INTEGER DEFAULT 1,
  updated_at TEXT
);

-- 提示词与策略版本库（FR-605）
CREATE TABLE IF NOT EXISTS prompt_versions (
  ver_id     TEXT PRIMARY KEY,
  kind       TEXT,                         -- tutor / guardrail / stage
  name       TEXT,
  content    TEXT,
  status     TEXT DEFAULT 'active',        -- active / gray / archived
  gray_scope TEXT DEFAULT '[]',            -- 灰度班级 ID 列表
  created_at TEXT,
  created_by TEXT
);

-- FR-702 模型调用日志（成本日报表 / 降级统计）
CREATE TABLE IF NOT EXISTS model_calls (
  id               TEXT PRIMARY KEY,
  session_id       TEXT,
  student_id       TEXT,
  model            TEXT,
  engine           TEXT,                    -- rule / llm
  tier             TEXT,                    -- light / strong
  cached           INTEGER DEFAULT 0,
  prompt_tokens    INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  latency_ms       INTEGER DEFAULT 0,
  fallback         INTEGER DEFAULT 0,       -- 1 = 由 LLM 降级至规则引擎
  created_at       TEXT
);

-- ============ M2 工具层 ============
-- Git 仓库登记（FR-203 提交轨迹分析；6.2 外部对接：API Token 只读）
CREATE TABLE IF NOT EXISTS git_repos (
  repo_id         TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL,
  platform        TEXT NOT NULL,             -- gitea / gitlab / github / manual
  url            TEXT,
  owner           TEXT,                     -- owner/repo（GitHub/Gitea）或 project id（GitLab）
  token           TEXT,                     -- 只读 Token；演示明文，生产建议环境变量注入
  default_branch  TEXT DEFAULT 'main',
  status          TEXT DEFAULT 'active',    -- active / unreachable / disabled
  last_synced_at  TEXT,
  last_error      TEXT,
  created_at      TEXT
);

-- Git 提交轨迹（平台同步或手工导入，均为只读快照）
CREATE TABLE IF NOT EXISTS git_commits (
  id                TEXT PRIMARY KEY,       -- group_id:sha
  repo_id           TEXT,
  group_id          TEXT NOT NULL,
  sha               TEXT NOT NULL,
  author_name       TEXT,
  author_student_id TEXT,                   -- 尽力匹配 students.name
  message           TEXT,
  branch            TEXT,
  files_changed     INTEGER DEFAULT 0,
  additions         INTEGER DEFAULT 0,
  deletions         INTEGER DEFAULT 0,
  committed_at      TEXT,
  UNIQUE(group_id, sha)
);

-- 工具层运行留痕（静态检查 / 单测执行 / Git 同步与导入，FR-603 过程数据仓库）
CREATE TABLE IF NOT EXISTS tool_runs (
  run_id      TEXT PRIMARY KEY,
  tool        TEXT NOT NULL,               -- static / unittest / git_sync / git_import
  student_id  TEXT,
  group_id    TEXT,
  session_id  TEXT,
  ok          INTEGER DEFAULT 1,
  summary     TEXT DEFAULT '{}',           -- JSON：各工具自定义摘要
  created_at  TEXT
);

-- ============ M3 团队协同（FR-301/302/303/206） ============
-- 站会（FR-301：每日一组一次，提示基于 Git 事实生成；不代填记录）
CREATE TABLE IF NOT EXISTS standups (
  id           TEXT PRIMARY KEY,
  group_id     TEXT NOT NULL,
  sprint_no    INTEGER DEFAULT 1,
  standup_date TEXT,                        -- YYYY-MM-DD，同组同日唯一
  prompt       TEXT DEFAULT '{}',           -- JSON：三问提示 + 组内 Git 事实
  status       TEXT DEFAULT 'open',         -- open / closed
  created_by   TEXT,
  created_at   TEXT,
  UNIQUE(group_id, standup_date)
);

CREATE TABLE IF NOT EXISTS standup_answers (
  id          TEXT PRIMARY KEY,
  standup_id  TEXT NOT NULL,
  student_id  TEXT NOT NULL,
  yesterday   TEXT,
  today       TEXT,
  blocker     TEXT,                         -- 阻碍项：非空则自动生成待办并同步教师端
  vague       INTEGER DEFAULT 0,            -- 空泛回答被追问标记
  created_at  TEXT,
  UNIQUE(standup_id, student_id)
);

-- 团队待办（站会阻碍项 / 复盘行动项 落地处）
CREATE TABLE IF NOT EXISTS team_todos (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  student_id  TEXT,
  source      TEXT DEFAULT 'standup',       -- standup / retro / manual
  text        TEXT NOT NULL,
  status      TEXT DEFAULT 'open',          -- open / done
  created_at  TEXT
);

-- 角色扮演（FR-302：PO/客户/评委；结束后必给观察反馈）
CREATE TABLE IF NOT EXISTS roleplays (
  id          TEXT PRIMARY KEY,
  group_id    TEXT,
  student_id  TEXT NOT NULL,
  role        TEXT NOT NULL,                -- po / customer / judge
  scenario    TEXT,
  status      TEXT DEFAULT 'active',        -- active / ended
  turns       INTEGER DEFAULT 0,
  clarifying  INTEGER DEFAULT 0,            -- 学生提出的澄清问题数
  transcript  TEXT DEFAULT '[]',            -- JSON：[{who:'agent'|'student', text}]
  feedback    TEXT,                         -- JSON：观察反馈（含 ≥2 条改进建议）
  created_at  TEXT,
  ended_at    TEXT
);

-- 贡献度自评与互评（FR-303：只存事实清单与学生自写评语；不存分数、不做排名）
CREATE TABLE IF NOT EXISTS peer_reviews (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  sprint_no   INTEGER DEFAULT 1,
  reviewer_id TEXT NOT NULL,
  reviewee_id TEXT NOT NULL,
  facts       TEXT DEFAULT '[]',            -- JSON：系统生成的事实清单
  note        TEXT,                         -- 学生自写评语（行为+影响句式）
  vague       INTEGER DEFAULT 0,
  created_at  TEXT,
  UNIQUE(group_id, sprint_no, reviewer_id, reviewee_id)
);

-- 小组复盘（FR-206 复盘沉淀：三栏 + 成长档案 + 补学清单；正文由学生自写）
CREATE TABLE IF NOT EXISTS retrospectives (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  sprint_no   INTEGER DEFAULT 1,
  good        TEXT,
  improve     TEXT,
  action      TEXT,
  growth      TEXT DEFAULT '{}',            -- JSON：成长档案汇总（系统聚合）
  study_list  TEXT DEFAULT '[]',            -- JSON：补学清单（由卡点倒推）
  created_at  TEXT,
  UNIQUE(group_id, sprint_no)
);

-- ============ M3 推送通道（FR-503 / 6.2 消息推送） ============
CREATE TABLE IF NOT EXISTS push_channels (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'wecom_webhook',  -- wecom_webhook / inbox
  webhook    TEXT,                          -- 企微群机器人 URL
  scope      TEXT DEFAULT '[]',             -- JSON：受众说明（仅备注）
  enabled    INTEGER DEFAULT 1,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS push_logs (
  id         TEXT PRIMARY KEY,
  channel_id TEXT,
  target     TEXT,                          -- 群名 / student_id / 'teachers'
  title      TEXT,
  body       TEXT,
  ok         INTEGER DEFAULT 0,
  error      TEXT,
  created_at TEXT
);

-- ============ M3 多端接入（FR-404） ============
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  device_type  TEXT NOT NULL,               -- web / h5 / miniprogram / vscode
  name         TEXT,
  device_token TEXT UNIQUE,                 -- 端侧长期令牌（dt_ 前缀）
  last_seq     INTEGER DEFAULT 0,           -- 该端已同步到的全局消息游标
  last_seen_at TEXT,
  created_at   TEXT
);

-- ============ M4 预警规则配置（FR-503/402：阈值可由教师修改并持久化） ============
CREATE TABLE IF NOT EXISTS alert_rules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  threshold    REAL DEFAULT 0,
  unit         TEXT,
  audience     TEXT,
  action       TEXT,
  text         TEXT,
  configurable INTEGER DEFAULT 1,
  enabled      INTEGER DEFAULT 1,
  updated_by   TEXT,
  updated_at   TEXT
);

-- ============ M4 学习节拍器（FR-401：Sprint 目标拆解为每日微目标） ============
CREATE TABLE IF NOT EXISTS daily_goals (
  id         TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  group_id   TEXT,
  sprint_no  INTEGER DEFAULT 1,
  stage      TEXT,                          -- 可追溯：所属阶段
  node_id    TEXT,                          -- 可追溯：对应剧本节点
  goal_date  TEXT NOT NULL,                 -- YYYY-MM-DD
  content    TEXT NOT NULL,
  source     TEXT DEFAULT 'suggested',      -- suggested 系统生成 / manual 学生自建
  status     TEXT DEFAULT 'open',           -- open / done / missed
  reason     TEXT,                          -- 未完成原因（分析用，非催促）
  created_at TEXT,
  updated_at TEXT
);

-- ============ M4 多模态附件（FR-105：结构化解析结果留痕） ============
CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  msg_id       TEXT,                        -- 关联的学生消息
  session_id   TEXT,
  student_id   TEXT,
  name         TEXT,
  mime         TEXT,
  size         INTEGER DEFAULT 0,
  kind         TEXT,                        -- code / text / image / other
  parse_result TEXT DEFAULT '{}',           -- JSON：结构化解析 + 置信度
  stored_path  TEXT,                        -- 落盘路径（data/uploads/）
  created_at   TEXT
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_goal_student ON daily_goals(student_id, goal_date);
CREATE INDEX IF NOT EXISTS idx_attach_msg ON attachments(msg_id);
CREATE INDEX IF NOT EXISTS idx_attach_session ON attachments(session_id);
CREATE INDEX IF NOT EXISTS idx_session_student ON sessions(student_id, last_at);
CREATE INDEX IF NOT EXISTS idx_event_student ON help_events(student_id, opened_at);
CREATE INDEX IF NOT EXISTS idx_artifact_group ON artifacts(group_id, stage);
CREATE INDEX IF NOT EXISTS idx_alert_status ON alerts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_guard_created ON guardrail_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_commit_group ON git_commits(group_id, committed_at);
CREATE INDEX IF NOT EXISTS idx_tool_run_student ON tool_runs(student_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tool_run_tool ON tool_runs(tool, created_at);
CREATE INDEX IF NOT EXISTS idx_standup_group ON standups(group_id, standup_date);
CREATE INDEX IF NOT EXISTS idx_todo_group ON team_todos(group_id, status);
CREATE INDEX IF NOT EXISTS idx_roleplay_student ON roleplays(student_id, created_at);
CREATE INDEX IF NOT EXISTS idx_review_group ON peer_reviews(group_id, sprint_no);
CREATE INDEX IF NOT EXISTS idx_pushlog_channel ON push_logs(channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_device_user ON devices(user_id);
