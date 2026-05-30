const fs = require('fs');
const path = require('path');
const AiBot = require('@wecom/aibot-node-sdk');
const { WSClient, generateReqId } = AiBot;
const BaseAdapter = require('./base-adapter');
const { handleCommand } = require('./wecom-commands');
const { log } = require('../shared/logger');
const config = require('../shared/config');

// 注入到每个 CC session 的 system prompt 追加内容
// 让 CC 知道它可以生成文件并输出标记，由渠道层负责发送
const CHANNEL_SYSTEM_PROMPT = `
You are running inside a messaging gateway that CAN deliver files to users.
When you save a file (image, screenshot, chart, document, etc.), output this marker on its own line:
[FILE: /absolute/path/to/file.ext]
The gateway will automatically deliver it. NEVER say "I can't send files" — just save and mark.
`.trim();

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function createSdkLogger(level) {
  const threshold = LOG_LEVELS[level] || LOG_LEVELS.info;
  return {
    debug(msg, ...args) { if (threshold <= 0) log('sdk', msg); },
    info(msg, ...args) { if (threshold <= 1) log('sdk', msg); },
    warn(msg, ...args) { if (threshold <= 2) log('sdk', `WARN: ${msg}`); },
    error(msg, ...args) { log('sdk', `ERROR: ${msg}`); },
  };
}

class WeComAdapter extends BaseAdapter {
  constructor(options = {}) {
    super({ name: 'wecom', renderer: options.renderer });
    this.store = options.store;
    this.router = options.router;
    this.botId = options.botId || config.wecom.botId;
    this.botSecret = options.botSecret || config.wecom.botSecret;
    this.wsClient = null;
    this._warmSession = null;
  }

  async start() {
    if (!this.botId || !this.botSecret || this.botId === 'your-bot-id-here') {
      log('wecom', 'WeCom bot not configured, skipping.');
      return;
    }

    const sdkLogLevel = config.wecom.logLevel || 'info';
    this.wsClient = new WSClient({
      botId: this.botId,
      secret: this.botSecret,
      reconnectInterval: 2000,
      maxReconnectAttempts: -1,
      logger: createSdkLogger(sdkLogLevel),
    });

    this._bindEvents();
    this.wsClient.connect();
    log('wecom', 'WeCom bot connecting...');

    this._warmUp();
  }

  async stop() {
    if (this.wsClient) this.wsClient.disconnect();
  }

  async send(userId, message) {
    if (!this.wsClient) return;
    const content = typeof message === 'string' ? message : message.content;
    const body = { msgtype: 'markdown', markdown: { content } };

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.wsClient.sendMessage(userId, body);
        return;
      } catch (e) {
        log('wecom', `sendMessage attempt ${attempt + 1} failed: ${e.message || JSON.stringify(e)}`);
        if (attempt < 2) await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
  }

  // 上传并发送本地文件（图片或普通文件）
  async sendFile(userId, filePath) {
    if (!this.wsClient || !fs.existsSync(filePath)) return;
    const ext = path.extname(filePath).toLowerCase();
    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
    const mediaType = imageExts.includes(ext) ? 'image' : 'file';

    try {
      const buffer = fs.readFileSync(filePath);
      const result = await this.wsClient.uploadMedia(buffer, {
        type: mediaType,
        filename: path.basename(filePath),
      });
      await this.wsClient.sendMediaMessage(userId, mediaType, result.media_id);
      log('wecom', `Sent ${mediaType} to ${userId}: ${path.basename(filePath)}`);
    } catch (e) {
      log('wecom', `sendFile failed for ${filePath}: ${e.message}`);
      // 降级：发文件路径文本
      await this.send(userId, `📎 文件已生成：\`${filePath}\``);
    }
  }

  _warmUp() {
    const id = 'wecom_warmup';
    this._warmSession = this.store.create(id, {
      cwd: require('../shared/platform').homedir(),
      appendSystemPrompt: CHANNEL_SYSTEM_PROMPT,
    });
    this._warmSession.start();
    log('wecom', 'Pre-warming Claude session...');
  }

  _getUserSession(userId) {
    let session = this.store.getByUser(userId);
    if (session && session.agent.alive) return session;

    if (this._warmSession && this._warmSession.phase === 'idle' && this._warmSession.agent.alive) {
      const id = `wecom_${userId.slice(-6)}`;
      const claimed = this._warmSession;
      claimed.id = id;
      this.store.sessions.delete('wecom_warmup');
      this.store.sessions.set(id, claimed);
      this.store.setUserSession(userId, id);
      this._warmSession = null;
      log('wecom', `Assigned warm session to user ${userId} (${id})`);
      return claimed;
    }

    const id = `wecom_${userId.slice(-6)}`;
    session = this.store.create(id, {
      cwd: require('../shared/platform').homedir(),
      appendSystemPrompt: CHANNEL_SYSTEM_PROMPT,
    });
    this.store.setUserSession(userId, id);
    session.start();
    log('wecom', `Created session ${id} for user ${userId}`);
    return session;
  }

  _bindEvents() {
    const ws = this.wsClient;
    ws.on('authenticated', () => log('wecom', 'Authenticated'));
    ws.on('connected', () => log('wecom', 'Connected'));
    ws.on('disconnected', (reason) => {
      log('wecom', `Disconnected: ${reason}`);
      this._scheduleReconnect();
    });
    ws.on('error', (e) => log('wecom', `Error: ${e.message}`));

    ws.on('event.enter_chat', (frame) => this._onEnterChat(frame));
    ws.on('message.text', (frame) => this._onText(frame));
    ws.on('message.image', (frame) => this._onImage(frame));
    ws.on('message.voice', (frame) => this._onVoice(frame));
    ws.on('message.file', (frame) => this._onFile(frame));
    ws.on('message.mixed', (frame) => this._onMixed(frame));
    ws.on('event.template_card_event', (frame) => this._onCardEvent(frame));
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const delay = 5000;
    log('wecom', `Scheduling reconnect in ${delay}ms...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      log('wecom', 'Reconnecting...');
      this.wsClient.connect();
    }, delay);
  }

  _onEnterChat(_frame) {}

  async _onText(frame) {
    const userId = frame.body?.from?.userid || 'unknown';
    const text = (frame.body?.text?.content || '').trim();
    if (!text) return;
    log('wecom', `Text from ${userId}: ${text.substring(0, 100)}`);

    if (text.startsWith('/')) {
      await this._handleCommand(frame, userId, text);
    } else {
      await this._handleMessage(frame, userId, text);
    }
  }

  async _onVoice(frame) {
    const userId = frame.body?.from?.userid || 'unknown';
    const text = (frame.body?.voice?.content || '').trim();
    if (!text) { await this._replyText(frame, '未识别到语音内容'); return; }
    if (text.startsWith('/')) await this._handleCommand(frame, userId, text);
    else await this._handleMessage(frame, userId, text);
  }

  async _onImage(frame) {
    const userId = frame.body?.from?.userid || 'unknown';
    try {
      const { buffer, filename } = await this.wsClient.downloadFile(frame.body.image?.url, frame.body.image?.aeskey);
      const safeName = Date.now() + '_' + (filename || 'image.png').replace(/[^a-zA-Z0-9._\-]/g, '_');
      const filePath = path.join(config.paths.uploads, safeName);
      fs.writeFileSync(filePath, buffer);
      await this._handleMessage(frame, userId, `请查看并描述这张图片: ${filePath}`);
    } catch (e) {
      await this._replyText(frame, '图片下载失败，请重试');
    }
  }

  async _onFile(frame) {
    const userId = frame.body?.from?.userid || 'unknown';
    const filename = frame.body?.file?.filename || 'unknown';
    try {
      const { buffer, filename: dlName } = await this.wsClient.downloadFile(frame.body.file?.url, frame.body.file?.aeskey);
      const actualName = dlName || filename;
      const safeName = Date.now() + '_' + actualName.replace(/[^a-zA-Z0-9._\-一-鿿]/g, '_');
      const filePath = path.join(config.paths.uploads, safeName);
      fs.writeFileSync(filePath, buffer);
      await this._handleMessage(frame, userId, `用户发送了文件「${actualName}」，已保存到: ${filePath}\n请读取并分析这个文件的内容。`);
    } catch (e) {
      await this._replyText(frame, '文件下载失败，请重试');
    }
  }

  async _onMixed(frame) {
    const userId = frame.body?.from?.userid || 'unknown';
    const items = frame.body?.mixed?.msg_item || [];
    let textParts = [], fileParts = [];

    for (const item of items) {
      if (item.msgtype === 'text' && item.text?.content) {
        textParts.push(item.text.content);
      } else if (item.msgtype === 'image' && item.image?.url) {
        try {
          const { buffer, filename } = await this.wsClient.downloadFile(item.image.url, item.image.aeskey);
          const safeName = Date.now() + '_' + (filename || 'image.png').replace(/[^a-zA-Z0-9._\-]/g, '_');
          const filePath = path.join(config.paths.uploads, safeName);
          fs.writeFileSync(filePath, buffer);
          fileParts.push(`[图片: ${filePath}]`);
        } catch (_) {}
      } else if (item.msgtype === 'file' && item.file?.url) {
        try {
          const { buffer, filename } = await this.wsClient.downloadFile(item.file.url, item.file.aeskey);
          const actualName = filename || 'file';
          const safeName = Date.now() + '_' + actualName.replace(/[^a-zA-Z0-9._\-一-鿿]/g, '_');
          const filePath = path.join(config.paths.uploads, safeName);
          fs.writeFileSync(filePath, buffer);
          fileParts.push(`[文件「${actualName}」: ${filePath}]`);
        } catch (_) {}
      } else if (item.msgtype === 'voice' && item.voice?.content) {
        textParts.push(item.voice.content);
      }
    }

    let fullText = textParts.join(' ').trim();
    if (!fullText && !fileParts.length) return;
    if (fileParts.length) {
      fullText = fullText
        ? fullText + '\n\n' + fileParts.join('\n') + '\n请结合上述文件内容回答。'
        : '请查看并分析以下内容:\n' + fileParts.join('\n');
    }

    if (fullText.startsWith('/')) await this._handleCommand(frame, userId, fullText);
    else await this._handleMessage(frame, userId, fullText || '请分析这个文件');
  }

  async _onCardEvent(frame) {
    const key = frame.body?.event?.button_key || '';
    const userId = frame.body?.from?.userid || 'unknown';
    const session = this._getUserSession(userId);

    // Interactive prompt responses. We no longer send button cards (prompts are
    // delivered as plain text), but keep these handlers so any in-flight legacy
    // card still works — route the reply through the same text-based flow.
    if (key === 'interactive_approve' || key === 'interactive_deny' || key.startsWith('interactive_opt_')) {
      const reply = key === 'interactive_approve' ? '确认'
        : key === 'interactive_deny' ? '取消'
        : key.replace('interactive_opt_', '');
      this._ensureInteractiveBound(userId, session);
      session.sendMessage(reply, async (response) => {
        if (session.phase === 'awaiting_input') return;
        if (response) await this.send(userId, this._condenseResponse(response));
      });
      await this._replyText(frame, key === 'interactive_deny' ? '❌' : '✅').catch(() => {});
      return;
    }

    switch (key) {
      case 'new_session': {
        const id = `wecom_${userId.slice(-6)}_${Date.now().toString(36)}`;
        const newSession = this.store.create(id, {
          cwd: require('../shared/platform').homedir(),
          appendSystemPrompt: CHANNEL_SYSTEM_PROMPT,
        });
        this.store.setUserSession(userId, id);
        newSession.start();
        await this._replyText(frame, `✅ 新会话 ${id}`);
        break;
      }
      case 'stop': {
        session.sendKey('ctrl+c');
        await this._replyText(frame, '⏹ 已中断');
        break;
      }
      default:
        if (key) await this._sendToClaudeStream(frame, session, `/${key.replace('_mode', '')}`);
    }
  }

  async _handleCommand(frame, userId, text) {
    await handleCommand(this, frame, userId, text);
  }

  async _handleMessage(frame, userId, text) {
    const session = this._getUserSession(userId);
    await this._sendToClaudeStream(frame, session, text);
  }

  async _sendToClaudeStream(frame, session, text) {
    const userId = frame.body?.from?.userid;
    const streamId = generateReqId('stream');

    try { await this.wsClient.replyStream(frame, streamId, '⏳ 收到，处理中...', true); } catch (_) {}

    if (session.phase === 'stopped' || session.phase === 'init') {
      const ready = await this._waitForIdle(session, 120000);
      if (!ready) {
        await this.send(userId, '⚠️ Claude 未就绪，请稍后重试');
        return;
      }
    }

    // Listen for interactive prompt (multi-step questions). Delivered as plain
    // text; the user replies with an option number or the literal input, and
    // each reply flows back through here, re-arming for the next step until
    // Claude produces a final answer.
    this._ensureInteractiveBound(userId, session);

    session.sendMessage(text, async (response) => {
      // An interactive transition fires this callback with the formatted prompt,
      // but the persistent interactive-prompt listener already delivers it —
      // skip so we don't double-send.
      if (session.phase === 'awaiting_input') return;
      if (response) {
        const condensed = this._condenseResponse(response);

        // 解析 CC 输出的 [FILE: path] 标记，提取并发送文件
        const { text: textOnly, files } = this._extractFiles(condensed);

        if (textOnly.trim()) {
          const chunks = this._splitResponse(textOnly, 18000);
          for (const chunk of chunks) await this.send(userId, chunk);
        }

        for (const filePath of files) {
          await this.sendFile(userId, filePath);
        }
      } else {
        await this.send(userId, '⚠️ 未提取到响应，请重试');
      }
    });
  }

  // Bind a persistent listener that delivers every interactive prompt for this
  // session as plain text. Survives multi-step flows (select → input → select …)
  // because it stays attached across steps; torn down when the session finishes
  // (response-complete) or stops. Idempotent per session.
  _ensureInteractiveBound(userId, session) {
    if (session._wecomInteractiveBound) return;
    session._wecomInteractiveBound = true;

    const onInteractive = async ({ message }) => {
      if (message && message.trim()) {
        const chunks = this._splitResponse(message, 18000);
        for (const chunk of chunks) await this.send(userId, chunk);
      }
    };
    const teardown = () => {
      session.removeListener('interactive-prompt', onInteractive);
      session.removeListener('response-complete', teardown);
      session.removeListener('exit', teardown);
      session._wecomInteractiveBound = false;
    };

    session.on('interactive-prompt', onInteractive);
    session.once('response-complete', teardown);
    session.once('exit', teardown);
  }

  _condenseResponse(text) {
    if (!text) return text;
    const lines = text.split('\n');
    const condensed = [];
    let inToolBlock = false;
    let toolBlockLines = 0;

    for (const line of lines) {
      // Detect tool output blocks (file contents, command output, etc.)
      if (/^```/.test(line)) {
        if (inToolBlock) {
          inToolBlock = false;
          if (toolBlockLines > 20) {
            condensed.push(`  ... (${toolBlockLines} 行，已省略)`);
          }
          condensed.push(line);
        } else {
          inToolBlock = true;
          toolBlockLines = 0;
          condensed.push(line);
        }
        continue;
      }

      if (inToolBlock) {
        toolBlockLines++;
        if (toolBlockLines <= 20) condensed.push(line);
        continue;
      }

      // Skip verbose tool summaries
      if (/^(Read|Wrote|Created|Edited|Deleted|Searched|Listed|Found|Executed|Ran)\s+\d+/.test(line.trim())) continue;
      if (/^[\/~][\w\/.@-]+:\d+/.test(line.trim())) continue;

      condensed.push(line);
    }

    return condensed.join('\n').trim();
  }

  _extractFiles(text) {
    const SENDABLE_EXTS = new Set([
      '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.tar', '.gz',
    ]);
    const files = [];
    const seen = new Set();

    const lines = text.split('\n').filter(line => {
      const m = line.trim().match(/^\[FILE:\s*(.+?)\s*\]$/);
      if (m) { files.push(m[1]); seen.add(m[1]); return false; }
      return true;
    });

    const remaining = lines.join('\n');
    const pathMatches = remaining.match(/(?:^|\s|`|'|")(\/[\w./_-]+\.[\w]+)/gm) || [];
    for (const raw of pathMatches) {
      const p = raw.trim().replace(/^[`'"]+|[`'"]+$/g, '');
      if (seen.has(p)) continue;
      const ext = path.extname(p).toLowerCase();
      if (!SENDABLE_EXTS.has(ext)) continue;
      if (!fs.existsSync(p)) continue;
      seen.add(p);
      files.push(p);
    }

    return { text: remaining.trim(), files };
  }

  async _sendStatusCard(frame, session) {
    const emoji = { idle: '🟢', processing: '🟡', sent_msg: '🔵', init: '⚪', stopped: '🔴' };
    try {
      await this.wsClient.replyTemplateCard(frame, {
        card_type: 'text_notice',
        main_title: { title: `${emoji[session.phase] || '❓'} ${session.id}` },
        sub_title_text: `${session.phase} | ${session.history.length}条 | ${session.cwd}`,
        button_list: [
          { text: '新建', key: 'new_session', style: 2 },
          { text: '中断', key: 'stop', style: 2 },
          { text: 'Plan', key: 'plan_mode', style: 1 },
          { text: 'Code', key: 'code_mode', style: 1 },
        ],
        task_id: `s_${Date.now()}`,
      });
    } catch (e) {
      await this._replyText(frame, `${emoji[session.phase] || '❓'} ${session.id} | ${session.phase} | ${session.history.length}条`);
    }
  }

  async _replyText(frame, content) {
    try {
      await this.wsClient.reply(frame, { msgtype: 'markdown', markdown: { content } });
    } catch (e) { log('wecom', `replyText error: ${e.message}`); }
  }

  _splitResponse(text, maxBytes) {
    const buf = Buffer.from(text, 'utf8');
    if (buf.length <= maxBytes) return [text];
    const chunks = [];
    let offset = 0;
    while (offset < buf.length) {
      let end = Math.min(offset + maxBytes, buf.length);
      if (end < buf.length) {
        const slice = buf.slice(offset, end).toString('utf8');
        const lastNewline = slice.lastIndexOf('\n');
        if (lastNewline > maxBytes / 2) end = offset + Buffer.byteLength(slice.substring(0, lastNewline + 1), 'utf8');
      }
      chunks.push(buf.slice(offset, end).toString('utf8'));
      offset = end;
    }
    return chunks;
  }

  async _waitForIdle(session, maxWaitMs) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (session.phase === 'idle' || session.phase === 'awaiting_input') return true;
      if (session.phase === 'stopped') return false;
      await new Promise(r => setTimeout(r, 500));
    }
    return false;
  }
}

module.exports = WeComAdapter;
