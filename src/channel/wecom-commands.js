const { log } = require('../shared/logger');

const CLI_COMMANDS = ['/context', '/compact', '/model', '/plan', '/code', '/init', '/skills'];

async function handleCommand(adapter, frame, userId, text) {
  const parts = text.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const session = adapter._getUserSession(userId);

  if (CLI_COMMANDS.includes(cmd)) {
    await adapter._sendToClaudeStream(frame, session, cmd);
    return;
  }

  switch (cmd) {
    case '/testcard': {
      await adapter._replyText(frame, '发送测试卡片...');
      await adapter._sendInteractiveCard(userId, {
        type: 'select',
        prompt: '测试：选择一个方案',
        options: ['方案A：微服务', '方案B：单体优化', '方案C：事件驱动'],
        selected: null,
      }, '测试卡片');
      break;
    }
    case '/new': {
      const id = `wecom_${userId.slice(-6)}_${Date.now().toString(36)}`;
      const newSession = adapter.store.create(id, { cwd: require('../shared/platform').homedir() });
      adapter.store.setUserSession(userId, id);
      newSession.start();
      await adapter._replyText(frame, `✅ 新会话 ${id}`);
      break;
    }
    case '/sessions': {
      const list = adapter.store.list();
      if (!list.length) { await adapter._replyText(frame, '暂无活跃会话'); break; }
      const lines = list.map(s => `• \`${s.id}\` ${s.status} (${s.messageCount}条)`);
      await adapter._replyText(frame, lines.join('\n'));
      break;
    }
    case '/stop': {
      session.sendKey('ctrl+c');
      await adapter._replyText(frame, '⏹ 已中断');
      break;
    }
    case '/status': {
      await adapter._sendStatusCard(frame, session);
      break;
    }
    case '/help': {
      await adapter._replyText(frame, [
        '`/context` 上下文 | `/compact` 压缩 | `/model` 模型',
        '`/plan` 计划 | `/code` 代码 | `/stop` 中断',
        '`/new` 新建 | `/sessions` 列表 | `/status` 状态',
      ].join('\n'));
      break;
    }
    default:
      await adapter._replyText(frame, `未知命令 \`${cmd}\`，发 /help 查看`);
  }
}

module.exports = { handleCommand, CLI_COMMANDS };
