# cc-on-wecom

多渠道 Claude Code 网关，通过分层架构将 Claude Code CLI 接入企业微信、Web 及更多平台。支持 macOS、Linux 和 Windows。

## 核心能力

- **多渠道接入** — 企业微信、Web WebSocket，可扩展飞书/钉钉（只需写薄适配器）
- **分层架构** — CLI Agent → 语义解析 → 交互渲染 → 渠道适配，各层职责清晰
- **跨平台** — 自动识别 macOS/Linux/Windows，路径、进程检测、信号处理均已适配
- **会话管理** — 多用户独立会话，自动创建/恢复/销毁，支持会话预热
- **智能状态机** — 虚拟终端解析 Claude Code 屏幕输出，自动识别空闲/处理中/交互提示
- **超时安全** — 企微端立即确认收到，长任务完成后通过主动推送送达（不依赖 req_id 有效期）
- **输出精简** — 工具调用输出自动折叠，只返回必要结果
- **自动恢复** — 进程崩溃指数退避重启，心跳检测卡死进程

## 架构

```
┌───────────────────────────────────────────────────────────┐
│  Channel Adapters (Layer 4)                               │
│  web-adapter │ wecom-adapter │ feishu-adapter │ ...       │
├───────────────────────────────────────────────────────────┤
│  Interaction / Renderer (Layer 3)                         │
│  rich-renderer (cards/buttons) │ text-renderer            │
├───────────────────────────────────────────────────────────┤
│  Semantic Session (Layer 2)                               │
│  状态机 │ 响应提取 │ 提示检测 │ 结构化事件               │
├───────────────────────────────────────────────────────────┤
│  CLI Agent (Layer 1)                                      │
│  node-pty │ xterm 虚拟终端 │ 屏幕类型检测                │
├───────────────────────────────────────────────────────────┤
│  Session Store + Router (跨层)                            │
│  持久化 │ 用户→会话映射 │ 跨渠道路由                     │
└───────────────────────────────────────────────────────────┘
```

## 目录结构

```
cc-on-wecom/
├── index.js                 # 组合根
├── src/
│   ├── cli-agent/           # PTY 生命周期 + 屏幕解析
│   ├── semantic/            # 状态机 + 响应提取 + 提示检测
│   ├── interaction/         # rich/text 渲染器
│   ├── channel/             # 渠道适配器 (web, wecom, ...)
│   ├── session/             # 会话存储 + 路由
│   └── shared/              # 平台检测、日志、配置
├── public/                  # Web UI
└── package.json
```

## 快速开始

### 环境要求

- Node.js >= 18
- Claude Code CLI 已安装并在 PATH 中
  - macOS/Linux: 默认 `/usr/local/bin/claude`
  - Windows: 需要 `claude.cmd` 在 PATH 中
- 企业微信智能机器人凭证（可选，不配置则仅 Web 模式）

### 安装

```bash
git clone git@github.com:alunshqu/cc-on-wecom.git
cd cc-on-wecom
npm install
```

### 配置

```bash
cp .env.example .env
```

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `WECOM_BOT_ID` | 企业微信机器人 ID | — |
| `WECOM_BOT_SECRET` | 企业微信机器人密钥 | — |
| `PORT` | Web 服务端口 | `8890` |
| `CLAUDE_PATH` | Claude CLI 路径 | 自动检测 |
| `LOG_FILE` | 日志文件路径 | `<系统临时目录>/cc-on-wecom-debug.log` |

### 启动

```bash
npm start
```

启动后访问 `http://localhost:8890` 使用 Web 界面。启动日志会显示当前平台信息：

```
cc-on-wecom started on darwin/arm64 (Node v24.13.0). Channels: web, wecom
```

## 企业微信命令

| 命令 | 说明 |
|------|------|
| `/context` | 上下文用量 |
| `/compact` | 压缩上下文 |
| `/model` | 查看/切换模型 |
| `/plan` | 计划模式 |
| `/code` | 代码模式 |
| `/status` | 会话状态（带操作按钮） |
| `/sessions` | 会话列表 |
| `/new` | 新建会话 |
| `/stop` | 中断操作 |
| `/help` | 命令速查 |

支持发送图片、文件、语音、视频，Claude 会自动分析。

## 添加新渠道

只需实现一个 Channel Adapter：

```javascript
const BaseAdapter = require('./src/channel/base-adapter');

class FeishuAdapter extends BaseAdapter {
  constructor(options) { super({ name: 'feishu', renderer: options.renderer }); }
  async start() { /* 连接飞书 */ }
  async stop() { /* 断开 */ }
  async send(userId, message) { /* 发送消息 */ }
}
```

在 `index.js` 中注册即可：

```javascript
registry.register(new FeishuAdapter({ store, renderer: new RichRenderer() }));
```

## 日志

日志输出到系统临时目录：

```bash
# macOS/Linux
tail -f /tmp/cc-on-wecom-debug.log

# Windows
type %TEMP%\cc-on-wecom-debug.log
```

可通过 `LOG_FILE` 环境变量自定义路径。

## License

MIT
