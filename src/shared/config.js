const path = require('path');

module.exports = {
  claude: {
    path: process.env.CLAUDE_PATH || '/usr/local/bin/claude',
    args: ['--permission-mode', 'bypassPermissions'],
  },
  server: {
    port: parseInt(process.env.PORT || '8890', 10),
  },
  wecom: {
    botId: process.env.WECOM_BOT_ID,
    botSecret: process.env.WECOM_BOT_SECRET,
  },
  paths: {
    uploads: path.join(__dirname, '..', '..', 'uploads'),
    statePath: path.join(__dirname, '..', '..', 'uploads', 'session-state'),
  },
  context: {
    compactThreshold: parseFloat(process.env.CONTEXT_COMPACT_THRESHOLD || '0.85'),
    checkEveryTurns: parseInt(process.env.CONTEXT_CHECK_EVERY_TURNS || '6', 10),
    checkStaleMs: parseInt(process.env.CONTEXT_CHECK_STALE_MS || '600000', 10),
    compactCooldownMs: parseInt(process.env.CONTEXT_COMPACT_COOLDOWN_MS || '300000', 10),
  },
};
