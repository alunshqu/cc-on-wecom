const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./platform');

const LOG_FILE = process.env.LOG_FILE || path.join(tmpdir(), 'cc-on-wecom-debug.log');

try { fs.writeFileSync(LOG_FILE, ''); } catch (_) {}

function log(id, msg) {
  const line = `${new Date().toISOString()} [${id}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

module.exports = { log, LOG_FILE };
