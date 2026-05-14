const fs = require('fs');
const path = require('path');
const AiBot = require('@wecom/aibot-node-sdk');
const { WSClient, generateReqId } = AiBot;
const {
  createSession, sessions, sessionList, startClaude, log,
  sendToClaude, sendKeyToClaude, broadcastAll, warmupSession,
  UPLOAD_DIR,
} = require('./session-manager');

// ── Config ────────────────────────────────────────────────────────────────
const BOT_ID = process.env.WECOM_BOT_ID;
const BOT_SECRET = process.env.WECOM_BOT_SECRET;

if (!BOT_ID || !BOT_SECRET || BOT_ID === 'your-bot-id-here') {
  log('wecom', '⚠ WeCom bot not configured (WECOM_BOT_ID / WECOM_BOT_SECRET missing). Skipping.');
  module.exports = null;
  return;
}

log('wecom', `Starting WeCom bot: botId=${BOT_ID}`);

// ── Session mapping ───────────────────────────────────────────────────────
// Maps WeChat userid → Claude session id
const userSessionMap = new Map();

// Pre-warm a Claude session at startup for instant first message
const WARM_SESSION_ID = 'wecom_warmup';
let warmSession = warmupSession(WARM_SESSION_ID, process.env.HOME);
log('wecom', 'Pre-warming Claude session for instant first message...');

function getUserSession(userId) {
  let sessionId = userSessionMap.get(userId);
  if (sessionId && sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    if (s.ptyProc) return s;
    // Session exists but Claude is dead — will be auto-restarted
    return s;
  }
  // Claim the warm session if available and ready
  if (warmSession && warmSession.phase === 'idle' && warmSession.ptyProc) {
    const id = `wecom_${userId.slice(-6)}`;
    const claimed = warmSession;
    claimed.id = id;
    sessions.delete(WARM_SESSION_ID);
    sessions.set(id, claimed);
    userSessionMap.set(userId, id);
    log('wecom', `Assigned warm session to user ${userId} (${id})`);
    warmSession = null; // consumed
    return claimed;
  }
  // Create new session
  const id = `wecom_${userId.slice(-6)}`;
  const session = createSession(id, process.env.HOME);
  userSessionMap.set(userId, id);
  startClaude(session);
  log('wecom', `Created session ${id} for user ${userId}`);
  return session;
}

// ── SDK Client ────────────────────────────────────────────────────────────
const wsClient = new WSClient({
  botId: BOT_ID,
  secret: BOT_SECRET,
  reconnectInterval: 2000,
  maxReconnectAttempts: -1, // infinite
});

// ── Events ────────────────────────────────────────────────────────────────
wsClient.on('authenticated', () => log('wecom', 'Authenticated ✓'));
wsClient.on('connected', () => log('wecom', 'Connected ✓'));
wsClient.on('disconnected', (reason) => log('wecom', `Disconnected: ${reason}`));
wsClient.on('reconnecting', () => log('wecom', 'Reconnecting...'));
wsClient.on('error', (err) => log('wecom', `Error: ${err.message}`));

// ── Welcome ───────────────────────────────────────────────────────────────
wsClient.on('event.enter_chat', (frame) => {
  log('wecom', `User entered chat: ${frame.body?.from?.userid}`);
  wsClient.replyWelcome(frame, {
    msgtype: 'markdown',
    markdown: {
      content: [
        '👋 你好！我是 **Claude AI 助手**',
        '',
        '直接发送消息即可对话，也支持以下命令：',
        '',
        '`/help` — 查看命令列表',
        '`/status` — 查看会话状态',
        '`/new` — 新建会话',
        '`/plan` — 切换计划模式',
        '`/code` — 切回代码模式',
        '`/stop` — 中断当前操作',
        '`/context` — 查看上下文用量',
        '',
        '也可以直接发送 📷 图片或 📁 文件。',
      ].join('\n'),
    },
  });
});

// ── Text messages ─────────────────────────────────────────────────────────
wsClient.on('message.text', async (frame) => {
  const userId = frame.body?.from?.userid || 'unknown';
  const text = (frame.body?.text?.content || '').trim();
  log('wecom', `Text from ${userId}: ${text.substring(0, 100)}`);

  if (!text) return;

  if (text.startsWith('/')) {
    await handleCommand(frame, userId, text);
  } else {
    await handleNormalMessage(frame, userId, text);
  }
});

// ── Image messages ────────────────────────────────────────────────────────
wsClient.on('message.image', async (frame) => {
  const userId = frame.body?.from?.userid || 'unknown';
  log('wecom', `Image from ${userId}`);

  try {
    const { buffer, filename } = await wsClient.downloadFile(
      frame.body.image?.url, frame.body.image?.aeskey
    );
    const safeName = Date.now() + '_' + (filename || 'image.png').replace(/[^a-zA-Z0-9._\-]/g, '_');
    const filePath = path.join(UPLOAD_DIR, safeName);
    fs.writeFileSync(filePath, buffer);
    log('wecom', `Image saved: ${filePath} (${buffer.length} bytes)`);

    await handleNormalMessage(frame, userId, `请查看并描述这张图片: ${filePath}`);
  } catch (err) {
    log('wecom', `Image download error: ${err.message}`);
    await replyText(frame, '❌ 图片下载失败，请重试');
  }
});

// ── Voice messages ────────────────────────────────────────────────────────
wsClient.on('message.voice', async (frame) => {
  const userId = frame.body?.from?.userid || 'unknown';
  const text = (frame.body?.voice?.content || '').trim();
  log('wecom', `Voice from ${userId}: ${text.substring(0, 100)}`);

  if (!text) {
    await replyText(frame, '❌ 未识别到语音内容，请重试');
    return;
  }

  if (text.startsWith('/')) {
    await handleCommand(frame, userId, text);
  } else {
    await handleNormalMessage(frame, userId, text);
  }
});

// ── File messages ─────────────────────────────────────────────────────────
wsClient.on('message.file', async (frame) => {
  const userId = frame.body?.from?.userid || 'unknown';
  const filename = frame.body?.file?.filename || 'unknown';
  log('wecom', `File from ${userId}: ${filename}`);

  try {
    const { buffer, filename: dlName } = await wsClient.downloadFile(
      frame.body.file?.url, frame.body.file?.aeskey
    );
    const actualName = dlName || filename;
    const safeName = Date.now() + '_' + actualName.replace(/[^a-zA-Z0-9._\-一-鿿]/g, '_');
    const filePath = path.join(UPLOAD_DIR, safeName);
    fs.writeFileSync(filePath, buffer);
    log('wecom', `File saved: ${filePath} (${buffer.length} bytes)`);

    await handleNormalMessage(frame, userId, `用户发送了文件「${actualName}」，已保存到: ${filePath}\n请读取并分析这个文件的内容。`);
  } catch (err) {
    log('wecom', `File download error: ${err.message}`);
    await replyText(frame, '❌ 文件下载失败，请重试');
  }
});

// ── Video messages ────────────────────────────────────────────────────────
wsClient.on('message.video', async (frame) => {
  const userId = frame.body?.from?.userid || 'unknown';
  log('wecom', `Video from ${userId}`);

  try {
    const { buffer, filename } = await wsClient.downloadFile(
      frame.body.video?.url, frame.body.video?.aeskey
    );
    const safeName = Date.now() + '_' + (filename || 'video.mp4').replace(/[^a-zA-Z0-9._\-]/g, '_');
    const filePath = path.join(UPLOAD_DIR, safeName);
    fs.writeFileSync(filePath, buffer);
    log('wecom', `Video saved: ${filePath} (${buffer.length} bytes)`);

    await handleNormalMessage(frame, userId, `用户发送了一个视频文件，已保存到: ${filePath}`);
  } catch (err) {
    log('wecom', `Video download error: ${err.message}`);
    await replyText(frame, '❌ 视频下载失败，请重试');
  }
});

// ── Location messages ─────────────────────────────────────────────────────
wsClient.on('message.location', async (frame) => {
  const userId = frame.body?.from?.userid || 'unknown';
  const loc = frame.body?.location || {};
  const text = `用户分享了位置: ${loc.label || '未知地点'} (纬度:${loc.latitude}, 经度:${loc.longitude})`;
  log('wecom', `Location from ${userId}: ${text}`);
  await handleNormalMessage(frame, userId, text);
});

// ── Mixed messages (text + image) ─────────────────────────────────────────
wsClient.on('message.mixed', async (frame) => {
  const userId = frame.body?.from?.userid || 'unknown';
  log('wecom', `Mixed message from ${userId}`);

  const items = frame.body?.mixed?.msg_item || [];
  let textParts = [];
  let fileParts = [];

  for (const item of items) {
    if (item.msgtype === 'text' && item.text?.content) {
      textParts.push(item.text.content);
    } else if (item.msgtype === 'image' && item.image?.url) {
      try {
        const { buffer, filename } = await wsClient.downloadFile(item.image.url, item.image.aeskey);
        const safeName = Date.now() + '_' + (filename || 'image.png').replace(/[^a-zA-Z0-9._\-]/g, '_');
        const filePath = path.join(UPLOAD_DIR, safeName);
        fs.writeFileSync(filePath, buffer);
        fileParts.push(`[图片: ${filePath}]`);
      } catch (e) { log('wecom', `Mixed image error: ${e.message}`); }
    } else if (item.msgtype === 'file' && item.file?.url) {
      try {
        const { buffer, filename } = await wsClient.downloadFile(item.file.url, item.file.aeskey);
        const actualName = filename || 'file';
        const safeName = Date.now() + '_' + actualName.replace(/[^a-zA-Z0-9._\-一-鿿]/g, '_');
        const filePath = path.join(UPLOAD_DIR, safeName);
        fs.writeFileSync(filePath, buffer);
        fileParts.push(`[文件「${actualName}」: ${filePath}]`);
      } catch (e) { log('wecom', `Mixed file error: ${e.message}`); }
    } else if (item.msgtype === 'voice' && item.voice?.content) {
      textParts.push(item.voice.content);
    }
  }

  let fullText = textParts.join(' ').trim();
  if (!fullText && fileParts.length === 0) return;

  if (fileParts.length > 0) {
    const fileInfo = fileParts.join('\n');
    if (fullText) {
      fullText += '\n\n' + fileInfo + '\n请结合上述文件内容回答。';
    } else {
      fullText = '请查看并分析以下内容:\n' + fileInfo;
    }
  }

  if (fullText.startsWith('/')) {
    await handleCommand(frame, userId, fullText);
  } else {
    await handleNormalMessage(frame, userId, fullText || '请分析这个文件');
  }
});

// ── Template card button clicks ───────────────────────────────────────────
wsClient.on('event.template_card_event', async (frame) => {
  const key = frame.body?.event?.button_key || '';
  const userId = frame.body?.from?.userid || 'unknown';
  log('wecom', `Card button: ${key} from ${userId}`);

  switch (key) {
    case 'new_session': {
      const session = createNewSessionForUser(userId);
      await replyText(frame, `✅ 新会话已创建: ${session.id}`);
      break;
    }
    case 'stop': {
      const session = getUserSession(userId);
      const result = sendKeyToClaude(session, 'ctrl+c');
      await replyText(frame, result.ok ? '⏹ 已发送中断信号' : `❌ ${result.error}`);
      break;
    }
    case 'plan_mode': {
      const session = getUserSession(userId);
      await sendToClaudeAsync(frame, session, '/plan');
      break;
    }
    case 'code_mode': {
      const session = getUserSession(userId);
      await sendToClaudeAsync(frame, session, '/code');
      break;
    }
    case 'context': {
      const session = getUserSession(userId);
      await sendToClaudeAsync(frame, session, '/context');
      break;
    }
    default:
      await replyText(frame, `未知操作: ${key}`);
  }
});

// ── Feedback events ───────────────────────────────────────────────────────
wsClient.on('event.feedback_event', (frame) => {
  log('wecom', `Feedback: ${JSON.stringify(frame.body?.event)}`);
});

// ── Disconnect events ─────────────────────────────────────────────────────
wsClient.on('event.disconnected_event', (frame) => {
  log('wecom', `Server disconnect event: ${JSON.stringify(frame.body)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Command handler
// ═══════════════════════════════════════════════════════════════════════════

async function handleCommand(frame, userId, text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  const session = getUserSession(userId);

  switch (cmd) {
    // ── Claude CLI slash commands (pass through) ───────────────────────
    case '/context':
    case '/compact':
    case '/model':
    case '/plan':
    case '/code':
    case '/init':
    case '/skills':
    case '/release-notes': {
      await sendToClaudeAsync(frame, session, cmd);
      break;
    }

    // ── HappyWeb management commands ──────────────────────────────────
    case '/new': {
      const newSession = createNewSessionForUser(userId);
      await replyText(frame, `✅ 新会话已创建: ${newSession.id}`);
      break;
    }

    case '/switch': {
      const targetId = args[0];
      if (!targetId) {
        await replyText(frame, '用法: /switch <session_id>\n\n使用 /sessions 查看可用会话');
        break;
      }
      if (!sessions.has(targetId)) {
        await replyText(frame, `❌ 会话 ${targetId} 不存在`);
        break;
      }
      userSessionMap.set(userId, targetId);
      await replyText(frame, `✅ 已切换到会话: ${targetId}`);
      break;
    }

    case '/sessions': {
      const list = sessionList();
      if (list.length === 0) {
        await replyText(frame, '暂无活跃会话');
        break;
      }
      const lines = list.map(s =>
        `• \`${s.id}\` — ${s.status} | ${s.messageCount} msgs | ${new Date(s.created).toLocaleTimeString()}`
      );
      await replyText(frame, `📋 **活跃会话** (${list.length})\n\n${lines.join('\n')}`);
      break;
    }

    case '/stop': {
      const result = sendKeyToClaude(session, 'ctrl+c');
      await replyText(frame, result.ok ? '⏹ 已发送中断信号' : `❌ ${result.error}`);
      break;
    }

    case '/status': {
      await handleStatus(frame, session);
      break;
    }

    case '/kill': {
      const killId = args[0];
      if (!killId) {
        await replyText(frame, '用法: /kill <session_id>');
        break;
      }
      const killSession = sessions.get(killId);
      if (killSession) {
        if (killSession.ptyProc) killSession.ptyProc.kill();
        sessions.delete(killId);
        broadcastAll({ type: 'sessions', sessions: sessionList() });
        await replyText(frame, `🗑 会话 ${killId} 已删除`);
      } else {
        await replyText(frame, `❌ 会话 ${killId} 不存在`);
      }
      break;
    }

    case '/help': {
      if (args[0] === 'hw') {
        await replyText(frame, [
          '**HappyWeb 命令：**',
          '`/status` — 会话状态（带操作按钮）',
          '`/sessions` — 列出所有会话',
          '`/new` — 新建会话',
          '`/switch <id>` — 切换会话',
          '`/kill <id>` — 删除会话',
          '`/stop` — 中断当前操作',
          '`/help` — Claude CLI 帮助',
        ].join('\n'));
      } else {
        await replyText(frame, [
          '**可用命令：**',
          '',
          '**Claude CLI 命令：**',
          '`/context` — 上下文用量',
          '`/compact` — 压缩上下文',
          '`/model` — 查看/切换模型',
          '`/plan` — 切换计划模式',
          '`/code` — 切回代码模式',
          '`/init` — 初始化 CLAUDE.md',
          '`/skills` — 已安装技能',
          '',
          '**管理命令：**',
            '`/status` — 会话状态',
            '`/sessions` — 会话列表',
            '`/new` — 新建会话',
            '`/switch <id>` — 切换会话',
            '`/stop` — 中断操作',
            '`/help hw` — HappyWeb 命令',
        ].join('\n'));
      }
      break;
    }

    default:
      await replyText(frame, `❓ 未知命令: \`${cmd}\`\n\n发送 \`/help\` 查看可用命令`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Normal message → Claude
// ═══════════════════════════════════════════════════════════════════════════

async function waitForIdle(session, maxWaitMs = 30000) {
  if (session.phase === 'idle') return true;
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (session.phase === 'idle') return true;
    if (session.phase === 'stopped') return false;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

async function handleNormalMessage(frame, userId, text) {
  const session = getUserSession(userId);

  // Wait for Claude to be ready (handles first-message race with init)
  if (session.phase !== 'idle') {
    const streamId = generateReqId('stream');
    try {
      await wsClient.replyStream(frame, streamId, '⏳ 等待 Claude 就绪...', false);
    } catch (e) {}

    const ready = await waitForIdle(session);
    if (!ready) {
      try {
        await wsClient.replyStream(frame, streamId, '❌ Claude 启动超时，请重试', true);
      } catch (e) {}
      return;
    }
  }

  // Send "thinking" indicator
  const streamId = generateReqId('stream');

  try {
    await wsClient.replyStream(frame, streamId, '⏳ 处理中...', false);
  } catch (e) {
    log('wecom', `Stream start error: ${e.message}`);
  }

  // Send to Claude, wait for response
  const result = sendToClaude(session, text, async (response) => {
    try {
      if (response) {
        // Truncate if too long for WeCom (max ~20KB per stream call)
        const chunks = splitResponse(response, 18000);
        for (let i = 0; i < chunks.length; i++) {
          await wsClient.replyStream(frame, streamId, chunks[i], i === chunks.length - 1);
        }
      } else {
        await wsClient.replyStream(frame, streamId, '⚠️ 未能提取到响应，请重试', true);
      }
    } catch (e) {
      log('wecom', `Stream reply error: ${e.message}`);
    }
  });

  if (!result.ok) {
    try {
      await wsClient.replyStream(frame, streamId, `❌ ${result.error}`, true);
    } catch (e) {
      log('wecom', `Error reply failed: ${e.message}`);
    }
  }
}

/**
 * Send a Claude CLI command and stream the response back.
 */
async function sendToClaudeAsync(frame, session, cmd) {
  if (session.phase !== 'idle') {
    await replyText(frame, `⏳ Claude 正在处理中（${session.phase}），请稍候...`);
    return;
  }

  const streamId = generateReqId('stream');
  try {
    await wsClient.replyStream(frame, streamId, '⏳ 处理中...', false);
  } catch (e) {}

  const result = sendToClaude(session, cmd, async (response) => {
    try {
      if (response) {
        const chunks = splitResponse(response, 18000);
        for (let i = 0; i < chunks.length; i++) {
          await wsClient.replyStream(frame, streamId, chunks[i], i === chunks.length - 1);
        }
      } else {
        await wsClient.replyStream(frame, streamId, '⚠️ 无响应', true);
      }
    } catch (e) {
      log('wecom', `Cmd reply error: ${e.message}`);
    }
  });

  if (!result.ok) {
    try {
      await wsClient.replyStream(frame, streamId, `❌ ${result.error}`, true);
    } catch (e) {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Template card: /status
// ═══════════════════════════════════════════════════════════════════════════

async function handleStatus(frame, session) {
  if (!session) {
    await replyText(frame, '没有活跃会话，发送任意消息自动创建');
    return;
  }

  const phaseEmoji = {
    idle: '🟢', processing: '🟡', sent_msg: '🔵',
    init: '⚪', waiting_trust: '⚪', stopped: '🔴',
  };

  try {
    await wsClient.replyTemplateCard(frame, {
      card_type: 'text_notice',
      main_title: { title: '📋 会话状态' },
      sub_title_text: [
        `会话: ${session.id}`,
        `状态: ${phaseEmoji[session.phase] || '❓'} ${session.phase}`,
        `消息: ${session.history.length} 条`,
        `目录: ${session.cwd}`,
      ].join('\n'),
      button_list: [
        { text: '🔄 新会话', key: 'new_session', style: 2 },
        { text: '⏹ 中断', key: 'stop', style: 2 },
        { text: '📝 Plan', key: 'plan_mode', style: 1 },
        { text: '💻 Code', key: 'code_mode', style: 1 },
        { text: '📊 上下文', key: 'context', style: 1 },
      ],
      task_id: `status_${Date.now()}`,
    });
  } catch (e) {
    log('wecom', `Status card error: ${e.message}`);
    // Fallback to text
    await replyText(frame, [
      `📋 **会话状态**`,
      `会话: ${session.id}`,
      `状态: ${session.phase}`,
      `消息: ${session.history.length} 条`,
      `目录: ${session.cwd}`,
    ].join('\n'));
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function createNewSessionForUser(userId) {
  const id = `wecom_${userId.slice(-6)}_${Date.now().toString(36)}`;
  const session = createSession(id, process.env.HOME);
  userSessionMap.set(userId, id);
  startClaude(session);
  log('wecom', `New session ${id} for user ${userId}`);
  return session;
}

async function replyText(frame, content) {
  try {
    await wsClient.reply(frame, { msgtype: 'markdown', markdown: { content } });
  } catch (e) {
    log('wecom', `replyText error: ${e.message}`);
  }
}

function splitResponse(text, maxBytes) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return [text];

  const chunks = [];
  let offset = 0;
  while (offset < buf.length) {
    let end = Math.min(offset + maxBytes, buf.length);
    // Try to split at newline
    if (end < buf.length) {
      const slice = buf.slice(offset, end).toString('utf8');
      const lastNewline = slice.lastIndexOf('\n');
      if (lastNewline > maxBytes / 2) {
        end = offset + Buffer.byteLength(slice.substring(0, lastNewline + 1), 'utf8');
      }
    }
    chunks.push(buf.slice(offset, end).toString('utf8'));
    offset = end;
  }
  return chunks;
}

// ── Connect ───────────────────────────────────────────────────────────────
wsClient.connect();
log('wecom', 'WeCom bot connecting...');

// Graceful shutdown
process.on('SIGINT', () => {
  log('wecom', 'Shutting down...');
  wsClient.disconnect();
});

process.on('SIGTERM', () => {
  log('wecom', 'Shutting down...');
  wsClient.disconnect();
});

module.exports = { wsClient, userSessionMap };
