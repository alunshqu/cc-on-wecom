const path = require('path');
const { defaultClaudePath, homedir } = require('./platform');

module.exports = {
  claude: {
    path: process.env.CLAUDE_PATH || defaultClaudePath(),
    args: ['--permission-mode', 'bypassPermissions'],
  },
  server: {
    port: parseInt(process.env.PORT || '8890', 10),
  },
  wecom: {
    botId: process.env.WECOM_BOT_ID,
    botSecret: process.env.WECOM_BOT_SECRET,
    logLevel: process.env.WECOM_LOG_LEVEL || 'info',
  },
  paths: {
    uploads: path.join(__dirname, '..', '..', 'uploads'),
    statePath: path.join(__dirname, '..', '..', 'uploads', 'session-state'),
  },
};
