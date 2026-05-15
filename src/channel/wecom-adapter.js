const fs = require('fs');
const path = require('path');
const AiBot = require('@wecom/aibot-node-sdk');
const { WSClient, generateReqId } = AiBot;
const BaseAdapter = require('./base-adapter');
const { log } = require('../shared/logger');
const config = require('../shared/config');

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

    this.wsClient = new WSClient({
      botId: this.botId,
      secret: this.botSecret,
      reconnectInterval: 2000,
      maxReconnectAttempts: -1,
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
    try {
      await this.wsClient.sendMessage(userId, {
        msgtype: 'markdown',
        markdown: { content },
      });
    } catch (e) {
      log('wecom', `sendMessage to ${userId} failed: ${e.message}`);
    }
  }

  _warmUp() {
    const id = 'wecom_warmup';
    this._warmSession = this.store.create(id, { cwd: require('../shared/platform').homedir() });
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
    session = this.store.create(id, { cwd: require('../shared/platform').homedir() });
    this.store.setUserSession(userId, id);
    session.start();
    log('wecom', `Created session ${id} for user ${userId}`);
    return session;
  }

  _bindEvents() {
    const ws = this.wsClient;
    ws.on('authenticated', () => log('wecom', 'Authenticated'));
    ws.on('connected', () => log('wecom', 'Connected'));
    ws.on('disconnected', (r) => log('wecom', `Disconnected: ${r}`));
    ws.on('error', (e) => log('wecom', `Error: ${e.message}`));

    ws.on('event.enter_chat', (frame) => this._onEnterChat(frame));
    ws.on('message.text', (frame) => this._onText(frame));
    ws.on('message.image', (frame) => this._onImage(frame));
    ws.on('message.voice', (frame) => this._onVoice(frame));
    ws.on('message.file', (frame) => this._onFile(frame));
    ws.on('message.mixed', (frame) => this._onMixed(frame));
    ws.on('event.template_card_event', (frame) => this._onCardEvent(frame));
  }

  _onEnterChat(frame) {
    this.wsClient.replyWelcome(frame, {
      msgtype: 'text',
      text: { content: '你好！我是 Claude AI 助手，直接发消息即可对话。/help 查看命令。' },
    }).catch(e => log('wecom', `Welcome error: ${e.message || JSON.stringify(e)}`));
  }

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

    switch (key) {
      case 'new_session': {
        const id = `wecom_${userId.slice(-6)}_${Date.now().toString(36)}`;
        const newSession = this.store.create(id, { cwd: require('../shared/platform').homedir() });
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
    const parts = text.trim().split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const session = this._getUserSession(userId);

    const cliCommands = ['/context', '/compact', '/model', '/plan', '/code', '/init', '/skills'];
    if (cliCommands.includes(cmd)) {
      await this._sendToClaudeStream(frame, session, cmd);
      return;
    }

    switch (cmd) {
      case '/new': {
        const id = `wecom_${userId.slice(-6)}_${Date.now().toString(36)}`;
        const newSession = this.store.create(id, { cwd: require('../shared/platform').homedir() });
        this.store.setUserSession(userId, id);
        newSession.start();
        await this._replyText(frame, `✅ 新会话 ${id}`);
        break;
      }
      case '/sessions': {
        const list = this.store.list();
        if (!list.length) { await this._replyText(frame, '暂无活跃会话'); break; }
        const lines = list.map(s => `• \`${s.id}\` ${s.status} (${s.messageCount}条)`);
        await this._replyText(frame, lines.join('\n'));
        break;
      }
      case '/stop': {
        session.sendKey('ctrl+c');
        await this._replyText(frame, '⏹ 已中断');
        break;
      }
      case '/status': {
        await this._sendStatusCard(frame, session);
        break;
      }
      case '/help': {
        await this._replyText(frame, [
          '`/context` 上下文 | `/compact` 压缩 | `/model` 模型',
          '`/plan` 计划 | `/code` 代码 | `/stop` 中断',
          '`/new` 新建 | `/sessions` 列表 | `/status` 状态',
        ].join('\n'));
        break;
      }
      default:
        await this._replyText(frame, `未知命令 \`${cmd}\`，发 /help 查看`);
    }
  }

  async _handleMessage(frame, userId, text) {
    const session = this._getUserSession(userId);
    await this._sendToClaudeStream(frame, session, text);
  }

  async _sendToClaudeStream(frame, session, text) {
    const userId = frame.body?.from?.userid;
    const streamId = generateReqId('stream');

    // Immediately ack with replyStream (within req_id validity window)
    try { await this.wsClient.replyStream(frame, streamId, '⏳ 收到，处理中...', true); } catch (_) {}

    if (session.phase !== 'idle' && session.phase !== 'awaiting_input') {
      const ready = await this._waitForIdle(session, 30000);
      if (!ready) {
        await this.send(userId, '⚠️ Claude 未就绪，请稍后重试');
        return;
      }
    }

    session.sendMessage(text, async (response) => {
      if (response) {
        const condensed = this._condenseResponse(response);
        const chunks = this._splitResponse(condensed, 18000);
        for (const chunk of chunks) {
          await this.send(userId, chunk);
        }
      } else {
        await this.send(userId, '⚠️ 未提取到响应，请重试');
      }
    });
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
