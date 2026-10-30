# 知途伴学 · 部署到 Render（免费层）指南

> 目标：把完整前后端 + SQLite 项目挂到云端，**无需你开电脑**也能随时访问（固定 `*.onrender.com` 地址）。

---

## 一、我（WorkBuddy）已经帮你做好的部分

1. **自动 seed 自愈**：服务入口 `server/index.js` 在启动早期检测库是否为空，空则自动调用 `seed.js` 重建 35 张表 + 演示账号与数据（已存在则跳过）。这样 Render 免费层的临时盘每次休眠/重启被清空后，启动会自动恢复演示数据，**s001 / teacher / admin 账号始终可用**。已用全空库实测通过。
2. **`render.yaml`**：声明了免费 Web Service、Build/Start 命令、健康检查路径、Node 22.5 与关日志的环境变量，可直接“Import an existing render.yaml”。
3. **安全**：`.gitignore` 已排除 `data/`（含明文 API Key 的 `llm.json` 与学生数据）、`*.db`、`.env`，**这些不会进仓库、不会泄露**。
4. **本地已 `git init` 并提交初始版本**（已确认不含 `data/`）。

---

## 二、你需要做的（用自己的账号，约 5 分钟）

### 1) 准备账号
- GitHub（github.com）注册/登录
- Render（render.com）注册/登录 —— **免费层无需绑卡**

### 2) 推送代码到 GitHub
项目已初始化 git 并提交（不含 `data/`）。你只需：
```bash
cd 项目目录(zhitu)
git branch -M main
git remote add origin https://github.com/你的用户名/你的仓库.git
git push -u origin main
```

### 3) 在 Render 创建服务
- 打开 render.com → **New** → **Web Service** → 连接你的 GitHub 仓库
- 配置：
  - Runtime：**Node**
  - Plan：**Free**
  - Branch：**main**
  - Build Command：`npm install`
  - Start Command：`npm start`
- 或直接选 **“Import an existing render.yaml”** 套用本目录的 `render.yaml`
- 点 **Create Web Service**，等待部署（几分钟）

### 4) 拿到地址
部署完成后得到固定地址，例如：
```
https://zhitu-banxue.onrender.com
```
（服务名可在 Render 设置里改，地址随之变）

---

## 三、访问与演示账号

- 浏览器直接打开上面的地址，**前端页面 + 后端 API + SQLite 数据库 + AI 导学接口全部一体对外可用**。
- 登录账号（密码均为 `123456`）：
  - 学生：`s001`　教师：`teacher`　管理员：`admin`　助教：`ta`

---

## 四、必须知道的代价（演示前请阅读）

1. **休眠 / 冷启动**：免费层 **15 分钟无访问自动休眠**，下次打开需等约 **1 分钟**冷启动（Render 显示加载页）。**演示当天先自己点一下“预热”**，评委再开就秒进。
2. **数据库不持久**：临时盘每次休眠/重启/重部署会回到初始状态，自动 re-seed 一份**干净演示数据**；运行中新产生的账号/对话**不保留**。适合演示/比赛，不适合当真实上线系统（要持久请走学校 Linux 服务器）。
3. **真模型兜底**：学校 DeepSeek 网关 `ai-gateway.neusoft.edu.cn` 仅限校园网/VPN，云上连不上，自动走内置**规则引擎兜底**（对话可走、能演示，但不是真 AI 生成）。想云上用真模型，只能学校服务器（在校园网内）。
4. **额度**：750 实例小时/月，一个服务 24h 常开刚好够；超额则本月其余免费服务暂停。

---

## 五、停止 / 下线

- 云上：Render 面板 **Suspend** 或删除服务。
- 本地：运行 `stop-all.bat`（不影响云上）。

---

## 六、备选路线（如果你不想用自己账号）

- **学校 Linux 服务器 + 临时域名**（大赛通知里的企业微信自助申请）：免费、合规、在校园网内**真模型可用**、数据持久。代价是需走审批（用你学校账号）。
- **本机 + serveo 隧道**：演示当天让电脑开着，给一个公网链接（需注册公钥换成固定地址）。代价是要守着电脑。
