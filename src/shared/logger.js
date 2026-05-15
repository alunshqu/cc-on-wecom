const fs = require('fs');

const LOG_FILE = process.env.LOG_FILE || '/tmp/happyweb-debug.log';

try { fs.writeFileSync(LOG_FILE, ''); } catch (_) {}

function log(id, msg) {
  const line = `${new Date().toISOString()} [${id}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

module.exports = { log, LOG_FILE };
