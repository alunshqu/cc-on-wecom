const fs = require('fs');
const path = require('path');
const { tmpdir } = require('./platform');

const LOG_FILE = process.env.LOG_FILE || path.join(tmpdir(), 'cc-on-wecom-debug.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_LOG_FILES = 3;

try { if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, ''); } catch (_) {}

let _logSize = 0;
try { _logSize = fs.statSync(LOG_FILE).size; } catch (_) {}

function rotateIfNeeded() {
  if (_logSize < MAX_LOG_SIZE) return;
  try {
    for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
      const from = `${LOG_FILE}.${i}`;
      const to = `${LOG_FILE}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
    fs.writeFileSync(LOG_FILE, '');
    _logSize = 0;
  } catch (_) {}
}

function log(id, msg) {
  const line = `${new Date().toISOString()} [${id}] ${msg}\n`;
  try {
    fs.appendFileSync(LOG_FILE, line);
    _logSize += Buffer.byteLength(line);
    rotateIfNeeded();
  } catch (_) {}
}

module.exports = { log, LOG_FILE };
