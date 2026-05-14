const fs = require('fs');
const path = require('path');

const STATE_DIR = path.join(__dirname, 'uploads', 'session-state');
const SESSION_DIR = path.join(STATE_DIR, 'sessions');
const WECOM_MAP_FILE = path.join(STATE_DIR, 'wecom-user-sessions.json');

function ensureStateDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
}

function safeName(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function sessionStatePath(sessionId) {
  return path.join(SESSION_DIR, `${safeName(sessionId)}.json`);
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}
}

function serializeSession(session) {
  return {
    version: 1,
    id: session.id,
    cwd: session.cwd,
    created: session.created,
    updatedAt: Date.now(),
    history: Array.isArray(session.history) ? session.history : [],
    claude: {
      sessionId: session.claudeSessionId || null,
      resumeFailureCount: session.resumeFailureCount || 0,
      lastResumeAttemptAt: session.lastResumeAttemptAt || null,
      lastResumeSucceededAt: session.lastResumeSucceededAt || null,
    },
    context: session.context || {},
    restore: session.restore || {},
  };
}

function saveSession(session) {
  if (!session || session.durable === false || !session.id) return false;
  try {
    ensureStateDir();
    atomicWriteJson(sessionStatePath(session.id), serializeSession(session));
    return true;
  } catch (e) {
    console.error(`[durable-state] saveSession failed for ${session.id}: ${e.message}`);
    return false;
  }
}

function loadSession(sessionId) {
  try {
    const file = sessionStatePath(sessionId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`[durable-state] loadSession failed for ${sessionId}: ${e.message}`);
    return null;
  }
}

function loadAllSessions() {
  try {
    ensureStateDir();
    return fs.readdirSync(SESSION_DIR)
      .filter(name => name.endsWith('.json'))
      .map(name => {
        try {
          return JSON.parse(fs.readFileSync(path.join(SESSION_DIR, name), 'utf8'));
        } catch (e) {
          console.error(`[durable-state] failed to load ${name}: ${e.message}`);
          return null;
        }
      })
      .filter(s => s && s.id);
  } catch (e) {
    console.error(`[durable-state] loadAllSessions failed: ${e.message}`);
    return [];
  }
}

function deleteSessionState(sessionId) {
  try {
    const file = sessionStatePath(sessionId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return true;
  } catch (e) {
    console.error(`[durable-state] deleteSessionState failed for ${sessionId}: ${e.message}`);
    return false;
  }
}

function loadWecomUserSessionMap() {
  try {
    ensureStateDir();
    if (!fs.existsSync(WECOM_MAP_FILE)) return new Map();
    const data = JSON.parse(fs.readFileSync(WECOM_MAP_FILE, 'utf8'));
    return new Map(Object.entries(data.users || {}));
  } catch (e) {
    console.error(`[durable-state] loadWecomUserSessionMap failed: ${e.message}`);
    return new Map();
  }
}

function saveWecomUserSessionMap(map) {
  try {
    ensureStateDir();
    const users = {};
    for (const [userId, sessionId] of map) users[userId] = sessionId;
    atomicWriteJson(WECOM_MAP_FILE, { version: 1, updatedAt: Date.now(), users });
    return true;
  } catch (e) {
    console.error(`[durable-state] saveWecomUserSessionMap failed: ${e.message}`);
    return false;
  }
}

module.exports = {
  STATE_DIR,
  SESSION_DIR,
  WECOM_MAP_FILE,
  ensureStateDir,
  sessionStatePath,
  saveSession,
  loadSession,
  loadAllSessions,
  deleteSessionState,
  loadWecomUserSessionMap,
  saveWecomUserSessionMap,
};
