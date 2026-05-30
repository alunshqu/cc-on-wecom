const fs = require('fs');
const path = require('path');
const { SemanticSession } = require('../semantic');
const { log } = require('../shared/logger');
const config = require('../shared/config');
const { IS_WIN } = require('../shared/platform');

const STATE_DIR = config.paths.statePath;
const SESSION_DIR = path.join(STATE_DIR, 'sessions');
const WECOM_MAP_FILE = path.join(STATE_DIR, 'wecom-user-sessions.json');

function ensureStateDir() {
  fs.mkdirSync(SESSION_DIR, { recursive: true, ...(IS_WIN ? {} : { mode: 0o700 }) });
}

function safeName(id) {
  return String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function atomicWriteJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, ...(IS_WIN ? {} : { mode: 0o700 }) });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), IS_WIN ? {} : { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  if (!IS_WIN) { try { fs.chmodSync(filePath, 0o600); } catch (_) {} }
}

class SessionStore {
  constructor() {
    this.sessions = new Map();
    this.userMap = new Map();
  }

  get(id) { return this.sessions.get(id); }

  getByUser(userId) {
    const sessionId = this.userMap.get(userId);
    if (sessionId && this.sessions.has(sessionId)) return this.sessions.get(sessionId);
    return null;
  }

  create(id, options = {}) {
    const session = new SemanticSession({
      id,
      cwd: options.cwd || require('../shared/platform').homedir(),
      claudePath: config.claude.path,
      claudeSessionId: options.claudeSessionId || null,
      history: options.history || [],
      context: options.context || {},
      appendSystemPrompt: options.appendSystemPrompt || null,
    });
    this.sessions.set(id, session);
    this._attachPersistence(session);
    this._persist(session);
    return session;
  }

  // Re-persist whenever the conversation advances so history and the Claude
  // session id survive a restart. Debounced to avoid thrashing the disk on
  // rapid events. Bound once per session.
  _attachPersistence(session) {
    if (session._persistBound) return;
    session._persistBound = true;
    let timer = null;
    const save = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; this._persist(session); }, 500);
    };
    session.on('user-message', save);
    session.on('assistant-message', save);
    session.on('session-id-captured', save);
  }

  destroy(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.destroy();
      this.sessions.delete(id);
    }
    this._deleteState(id);
    this._removeUserMappings(id);
  }

  setUserSession(userId, sessionId) {
    this.userMap.set(userId, sessionId);
    this._saveUserMap();
  }

  list() {
    return [...this.sessions].map(([id, s]) => ({
      id,
      status: s.status,
      phase: s.phase,
      created: s.history[0]?.timestamp || Date.now(),
      cwd: s.cwd,
      messageCount: s.history.length,
    }));
  }

  restore() {
    try {
      ensureStateDir();
      const files = fs.readdirSync(SESSION_DIR).filter(n => n.endsWith('.json'));
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, file), 'utf8'));
          if (!data.id || this.sessions.has(data.id)) continue;
          const session = this.create(data.id, {
            cwd: data.cwd,
            claudeSessionId: data.claude?.sessionId || null,
            history: data.history || [],
            context: data.context || {},
          });
          log('store', `Restored session: ${data.id}`);
        } catch (e) {
          log('store', `Failed to restore ${file}: ${e.message}`);
        }
      }
    } catch (e) {
      log('store', `Restore failed: ${e.message}`);
    }
    this._loadUserMap();
  }

  persist(session) { this._persist(session); }
  deleteState(id) { this._deleteState(id); }

  // Internal persistence
  _persist(session) {
    try {
      ensureStateDir();
      const data = {
        version: 1,
        id: session.id,
        cwd: session.cwd,
        created: session.history[0]?.timestamp || Date.now(),
        updatedAt: Date.now(),
        history: session.history,
        claude: { sessionId: session.claudeSessionId },
        context: session.context,
      };
      atomicWriteJson(path.join(SESSION_DIR, `${safeName(session.id)}.json`), data);
    } catch (e) {
      log('store', `Persist failed for ${session.id}: ${e.message}`);
    }
  }

  _deleteState(id) {
    try {
      const file = path.join(SESSION_DIR, `${safeName(id)}.json`);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) {}
  }

  _removeUserMappings(sessionId) {
    let changed = false;
    for (const [userId, sid] of this.userMap) {
      if (sid === sessionId) { this.userMap.delete(userId); changed = true; }
    }
    if (changed) this._saveUserMap();
  }

  _loadUserMap() {
    try {
      ensureStateDir();
      if (!fs.existsSync(WECOM_MAP_FILE)) return;
      const data = JSON.parse(fs.readFileSync(WECOM_MAP_FILE, 'utf8'));
      this.userMap = new Map(Object.entries(data.users || {}));
    } catch (_) {}
  }

  _saveUserMap() {
    try {
      ensureStateDir();
      const users = {};
      for (const [userId, sessionId] of this.userMap) users[userId] = sessionId;
      atomicWriteJson(WECOM_MAP_FILE, { version: 1, updatedAt: Date.now(), users });
    } catch (_) {}
  }
}

module.exports = SessionStore;
