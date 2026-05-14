# Claude Code on WeCom

HappyWeb 是一个将 Claude Code CLI 接入企业微信的 Web 代理服务。它通过 PTY 管理 Claude Code 进程，提供 WebSocket 实时交互界面和企业微信机器人两种访问方式，让团队成员可以直接在企业微信中使用 Claude Code 的全部能力。

## 核心能力

- **企业微信集成** — 通过 WeCom AI Bot SDK 接入企业微信，支持文本、图片、文件、混合消息
- **Web 终端** — 浏览器端 WebSocket 实时交互界面，支持多会话管理
- **会话管理** — 多用户独立会话，自动创建/切换/销毁，支持会话预热（首次消息零等待）
- **智能状态检测** — 通过虚拟终端解析 Claude Code 的屏幕输出，自动识别空闲/处理中/完成等状态
- **自动恢复** — 进程崩溃自动重启（指数退避），心跳检测卡死进程并恢复
- **文件上传** — 支持通过 Web 和企业微信上传图片/文件供 Claude 分析
- **流式响应** — 企业微信端使用流式回复，处理中实时反馈

## 快速开始

### 环境要求

- Node.js >= 18
- Claude Code CLI 已安装（默认路径 `/usr/local/bin/claude`）
- 企业微信智能机器人凭证（可选，不配置则仅 Web 模式可用）

### 安装

```bash
cd happy-web
npm install
```

### 配置

复制环境变量模板并填写：

```bash
cp .env.example .env
```

`.env` 文件说明：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `WECOM_BOT_ID` | 企业微信机器人 ID | — |
| `WECOM_BOT_SECRET` | 企业微信机器人密钥 | — |
| `PORT` | Web 服务端口 | `8890` |
| `CLAUDE_PATH` | Claude CLI 路径 | `/usr/local/bin/claude` |

### 启动

```bash
npm start
```

启动后访问 `http://localhost:8890` 即可使用 Web 界面。

## 使用方式

### 企业微信

在企业微信中直接向机器人发送消息即可对话。支持的命令：

**Claude CLI 命令（透传）：**

| 命令 | 说明 |
|------|------|
| `/context` | 查看上下文用量 |
| `/compact` | 压缩上下文 |
| `/model` | 查看/切换模型 |
| `/plan` | 切换计划模式 |
| `/code` | 切回代码模式 |

**管理命令：**

| 命令 | 说明 |
|------|------|
| `/status` | 查看会话状态（含操作按钮） |
| `/sessions` | 列出所有活跃会话 |
| `/new` | 新建会话 |
| `/switch <id>` | 切换到指定会话 |
| `/kill <id>` | 删除指定会话 |
| `/stop` | 中断当前操作 |
| `/help` | 查看帮助 |

也支持直接发送图片或文件，Claude 会自动分析。

### Web 界面

打开 `http://localhost:8890`，通过浏览器 WebSocket 连接进行交互：

- 创建/加入/删除会话
- 实时查看 Claude 响应
- 发送消息和快捷键（Escape、Ctrl+C、Shift+Tab）
- 上传文件

## 架构

```
┌─────────────┐     WebSocket      ┌──────────────┐     PTY      ┌────────────┐
│  Web 浏览器  │◄──────────────────►│              │◄────────────►│            │
└─────────────┘                    │   server.js  │              │ Claude CLI │
                                   │              │              │            │
┌─────────────┐   WeCom AI SDK     │              │              └────────────┘
│  企业微信    │◄──────────────────►│   wecom.js   │
└─────────────┘                    └──────────────┘
                                         │
                                         ▼
                                   session-manager.js
                                   (PTY + 虚拟终端 + 状态机)
```

## 日志

运行时日志输出到 `/tmp/happyweb-debug.log`，可用于排查问题：

```bash
tail -f /tmp/happyweb-debug.log
```

## License

MIT
