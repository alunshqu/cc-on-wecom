const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const durableState = require('./durable-state');

const COLS = 120, ROWS = 200;
const SCROLLBACK = 5000;
const LOG_FILE = '/tmp/happyweb-debug.log';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const CONTEXT_COMPACT_THRESHOLD = parseFloat(process.env.CONTEXT_COMPACT_THRESHOLD || '0.85');
const CONTEXT_CHECK_EVERY_TURNS = parseInt(process.env.CONTEXT_CHECK_EVERY_TURNS || '6', 10);
const CONTEXT_CHECK_STALE_MS = parseInt(process.env.CONTEXT_CHECK_STALE_MS || '600000', 10);
const CONTEXT_COMPACT_COOLDOWN_MS = parseInt(process.env.CONTEXT_COMPACT_COOLDOWN_MS || '300000', 10);
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Clear log on start
try { fs.writeFileSync(LOG_FILE, ''); } catch(_) {}

function log(id, msg) {
  const line = `${new Date().toISOString()} [${id}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

const sessions = new Map();

function createSession(id, cwd, restored = {}) {
  const claude = restored.claude || {};
  const s = {
    id, ptyProc: null,
    vt: new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true }),
    clients: new Set(), status: 'starting',
    history: Array.isArray(restored.history) ? restored.history : [],
    cwd: restored.cwd || cwd || process.env.HOME,
    created: restored.created || Date.now(),
    durable: restored.durable !== false,
    claudeSessionId: claude.sessionId || restored.claudeSessionId || null,
    resumeFailureCount: claude.resumeFailureCount || 0,
    lastResumeAttemptAt: claude.lastResumeAttemptAt || null,
    lastResumeSucceededAt: claude.lastResumeSucceededAt || null,
    context: restored.context || {},
    restore: {
      ...(restored.restore || {}),
      needsHistorySeed: Boolean((restored.restore || {}).needsHistorySeed || (restored.history?.length && !(claude.sessionId || restored.claudeSessionId))),
    },
    phase: 'init',
    sentTrustEnter: false,
    userMsgSentAt: 0,
    sawProcessingSinceSent: false,
    onDataCount: 0,
    lastDetectedType: '',
    pollTimer: null,
    sentMsgTimeout: null,
    sentMsgAbsoluteTimeout: null,
    sentMsgScreenHash: null,
    screenChangedSinceSent: false,
    doneTimer: null,
    restartCount: 0,
    lastActivityAt: Date.now(),
    heartbeatTimer: null,
    lastExtractedResponse: null,
    pendingCallbacks: [],
    currentRequest: null,
    _messageQueue: [],
    _maintenanceQueued: null,
    _lastSpawnUsedResume: false,
    _spawnedFreshAfterResumeFailure: false,
  };
  sessions.set(id, s);
  saveSessionState(s);
  return s;
}

function saveSessionState(session) {
  if (!session || session.durable === false) return;
  durableState.saveSession(session);
}

function restorePersistedSessions({ start = true } = {}) {
  const restored = [];
  for (const state of durableState.loadAllSessions()) {
    if (!state.id || sessions.has(state.id)) continue;
    const session = createSession(state.id, state.cwd, state);
    restored.push(session);
    if (start) startClaude(session);
  }
  if (restored.length) log('server', `Restored ${restored.length} persisted sessions`);
  return restored;
}

function destroySession(id, { deleteState = true } = {}) {
  const session = sessions.get(id);
  if (!session) {
    if (deleteState) durableState.deleteSessionState(id);
    return false;
  }
  session._destroyed = true;
  if (session.ptyProc) {
    try { session.ptyProc.kill(); } catch (_) {}
  }
  stopPolling(session);
  if (session.sentMsgTimeout) clearTimeout(session.sentMsgTimeout);
  if (session.sentMsgAbsoluteTimeout) clearTimeout(session.sentMsgAbsoluteTimeout);
  if (session.doneTimer) clearTimeout(session.doneTimer);
  if (session._processingWatchdog) clearInterval(session._processingWatchdog);
  session.clients.clear();
  sessions.delete(id);
  if (deleteState) durableState.deleteSessionState(id);
  return true;
}

function broadcast(session, msg) {
  const p = JSON.stringify(msg);
  for (const c of session.clients) if (c.readyState === 1) c.send(p);
}

function broadcastAll(msg) {
  const p = JSON.stringify(msg);
  for (const [, s] of sessions) for (const c of s.clients) if (c.readyState === 1) c.send(p);
}

function sessionList() {
  return [...sessions].map(([id, s]) => ({
    id, status: s.status, created: s.created, cwd: s.cwd, messageCount: s.history.length,
  }));
}

function getScreenLines(vt) {
  const buf = vt.buffer.active;
  const lines = [];
  const totalRows = buf.baseY + buf.cursorY + 1;
  for (let i = 0; i < totalRows; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines;
}

function getViewportLines(vt) {
  const lines = [];
  for (let i = 0; i < vt.rows; i++) {
    const line = vt.buffer.active.getLine(vt.buffer.active.baseY + i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines;
}

function getScreenText(vt) { return getViewportLines(vt).join('\n'); }

function detectScreenType(text) {
  if (text.includes('trust this folder') || (text.includes('Yes, I trust') && text.includes('No, exit'))) {
    return 'trust_prompt';
  }

  const lines = text.split('\n');
  const nonEmptyLines = lines.filter(l => l.trim());
  const tail = nonEmptyLines.slice(-15).join('\n');

  if (/←.*Submit.*→/.test(tail) || /\b✔\s*Submit\b/.test(tail) ||
      (/^❯\s*\d+[.)、]/m.test(tail) && /[？?]|用什么|选择|输入|是否|确认|允许|可见性|仓库名/.test(tail))) {
    return 'interactive_prompt';
  }

  // Permission prompt (waiting for user approval)
  if (/Allow|Deny|allow once|allow always/i.test(text) && /\(y\/n\)|Yes.*No/i.test(text)) {
    return 'permission_prompt';
  }

  // Check last few lines for UI state (avoids matching response text)

  const activeProcessing =
    /(^|\n)\s*[✻●⏺◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\w+ing\b/m.test(tail) ||
    (/esc to interrupt/i.test(tail) && /(^|\n)\s*[✻●⏺◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/m.test(tail));

  if (activeProcessing) {
    return 'processing';
  }

  // Idle: prompt waiting for input
  // Claude Code idle screen has: ❯ (prompt line) + separator + bypass hint
  for (let i = nonEmptyLines.length - 1; i >= Math.max(0, nonEmptyLines.length - 6); i--) {
    if (/^❯\s*$/.test(nonEmptyLines[i].trim())) {
      return 'idle';
    }
  }
  if (/❯/.test(tail) && (
    tail.includes('bypass permissions') ||
    tail.includes('shift+tab') ||
    tail.includes('type your message')
  )) {
    return 'idle';
  }

  // Done: Claude finished a response (shows duration) — in tail only
  if (/[✻●⏺]\s*\w+ed\s+(in|for)\s+[\d.]+s/.test(tail) || /completed in [\d.]+s/i.test(tail)) {
    return 'done';
  }

  // Processing: Claude is actively working — only match UI indicators in tail
  if (activeProcessing) {
    return 'processing';
  }

  return 'unknown';
}

function findPromptForRequest(lines, requestText, searchStart) {
  if (!requestText) return -1;
  const normalizedRequest = String(requestText).trim();
  for (let i = searchStart; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('❯')) continue;
    const promptText = line.replace(/^❯\s*/, '').trim();
    if (promptText === normalizedRequest) return i;
  }
  return -1;
}

function extractResponse(vt, requestText) {
  const lines = getScreenLines(vt);

  // Find the LAST empty prompt line (❯ with nothing after it)
  let lastEmptyPrompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯\s*$/.test(lines[i].trim())) {
      lastEmptyPrompt = i;
      break;
    }
  }

  // Find the last user message prompt (❯ with content after it)
  let userMsgPrompt = -1;
  const searchStart = lastEmptyPrompt !== -1 ? lastEmptyPrompt - 1 : lines.length - 1;
  userMsgPrompt = findPromptForRequest(lines, requestText, searchStart);
  for (let i = searchStart; userMsgPrompt === -1 && i >= 0; i--) {
    if (/^❯\s+\S/.test(lines[i])) {
      userMsgPrompt = i;
      break;
    }
  }
  if (userMsgPrompt === -1) return null;

  // Extract response lines between user prompt and empty prompt
  const endLine = lastEmptyPrompt !== -1 ? lastEmptyPrompt : lines.length;
  const result = [];
  for (let i = userMsgPrompt + 1; i < endLine; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (isNoiseLine(trimmed)) continue;
    result.push(trimmed.replace(/^[✻●⏺◐◑◒◓]\s*/, ''));
  }
  while (result.length && !result[0]) result.shift();
  while (result.length && !result[result.length - 1]) result.pop();
  return result.join('\n').trim() || null;
}

function extractClaudeSessionId(text) {
  if (!text) return null;
  const match = text.match(/\b(?:Session(?:\s+ID)?|sessionId|conversation(?:\s+ID)?)[:"\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
  return match ? match[1] : null;
}

function captureClaudeSessionId(session, text) {
  const id = extractClaudeSessionId(text);
  if (!id || id === session.claudeSessionId) return false;
  session.claudeSessionId = id;
  session.resumeFailureCount = 0;
  log(session.id, `Captured Claude session id: ${id}`);
  saveSessionState(session);
  return true;
}

function encodeClaudeProjectPath(cwd) {
  return String(cwd || process.env.HOME).replace(/[^a-zA-Z0-9]/g, '-');
}

function discoverClaudeSessionIdFromLocalLogs(session) {
  if (!session || session.claudeSessionId) return null;
  const dir = path.join(process.env.HOME || '', '.claude', 'projects', encodeClaudeProjectPath(session.cwd));
  try {
    if (!fs.existsSync(dir)) return null;
    const spawnedAt = session.claudeSpawnedAt || session.created || 0;
    const candidates = fs.readdirSync(dir)
      .filter(name => name.endsWith('.jsonl'))
      .map(name => {
        const file = path.join(dir, name);
        const stat = fs.statSync(file);
        return { file, mtimeMs: stat.mtimeMs };
      })
      .filter(item => item.mtimeMs >= spawnedAt - 5000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 5);

    const found = [];
    for (const { file, mtimeMs } of candidates) {
      const firstChunk = fs.readFileSync(file, 'utf8').split('\n').slice(0, 5).join('\n');
      if (firstChunk && !firstChunk.includes(`"cwd":"${session.cwd}"`) && !firstChunk.includes(`"cwd": "${session.cwd}"`)) {
        continue;
      }
      const id = extractClaudeSessionId(firstChunk) || path.basename(file, '.jsonl');
      if (id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
        found.push({ id, mtimeMs });
      }
    }
    const uniqueIds = [...new Set(found.map(item => item.id))];
    if (uniqueIds.length === 1) {
      const id = uniqueIds[0];
      session.claudeSessionId = id;
      session.resumeFailureCount = 0;
      log(session.id, `Discovered Claude session id from local logs: ${id}`);
      saveSessionState(session);
      return id;
    }
    if (uniqueIds.length > 1) log(session.id, `Claude session id discovery ambiguous (${uniqueIds.length} candidates)`);
  } catch (e) {
    log(session.id, `Claude session id discovery failed: ${e.message}`);
  }
  return null;
}

function parseTokenCount(value, suffix) {
  if (!value) return null;
  const n = parseFloat(String(value).replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const unit = String(suffix || '').toLowerCase();
  if (unit === 'm') return Math.round(n * 1000000);
  if (unit === 'k') return Math.round(n * 1000);
  return Math.round(n);
}

function parseContextUsage(text) {
  if (!text) return null;
  let match = text.match(/context[^\n]*?([\d.,]+)\s*([kKmM]?)\s*\/\s*([\d.,]+)\s*([kKmM]?)/i) ||
    text.match(/([\d.,]+)\s*([kKmM]?)\s*\/\s*([\d.,]+)\s*([kKmM]?)\s*tokens/i);
  if (match) {
    const usedTokens = parseTokenCount(match[1], match[2]);
    const maxTokens = parseTokenCount(match[3], match[4]);
    if (usedTokens && maxTokens) return { usedTokens, maxTokens, percent: usedTokens / maxTokens };
  }
  match = text.match(/context[^\n]*?(\d{1,3})\s*%|(?:^|\s)(\d{1,3})\s*%\s*(?:context|used)/i);
  if (match) {
    const percentValue = parseInt(match[1] || match[2], 10);
    if (Number.isFinite(percentValue)) return { percent: percentValue / 100 };
  }
  return null;
}

function shouldCompact(context) {
  if (!context || typeof context.percent !== 'number') return false;
  if (Date.now() - (context.lastCompactedAt || 0) < CONTEXT_COMPACT_COOLDOWN_MS) return false;
  return context.percent >= CONTEXT_COMPACT_THRESHOLD;
}

function updateContextUsageFromText(session, text) {
  const usage = parseContextUsage(text);
  if (!usage) return false;
  const previous = session.context || {};
  const next = {
    ...previous,
    ...usage,
    lastCheckedAt: Date.now(),
  };
  next.needsCompact = shouldCompact(next);
  const changed =
    previous.usedTokens !== next.usedTokens ||
    previous.maxTokens !== next.maxTokens ||
    Math.round((previous.percent || 0) * 1000) !== Math.round((next.percent || 0) * 1000) ||
    previous.needsCompact !== next.needsCompact;
  session.context = next;
  if (changed) {
    log(session.id, `Context usage updated: ${Math.round((next.percent || 0) * 100)}%`);
    saveSessionState(session);
  }
  return true;
}

function isContextCheckDue(session) {
  const context = session.context || {};
  if (!context.lastCheckedAt) return true;
  if (Date.now() - context.lastCheckedAt >= CONTEXT_CHECK_STALE_MS) return true;
  return (context.turnsSinceLastCheck || 0) >= CONTEXT_CHECK_EVERY_TURNS;
}

function buildHistoryRestorePrompt(session) {
  const maxMessages = 20;
  const maxChars = 24000;
  const selected = [];
  let used = 0;
  for (let i = session.history.length - 1; i >= 0 && selected.length < maxMessages; i--) {
    const entry = session.history[i];
    const line = `[${entry.role}] ${entry.content}`;
    const len = line.length + 2;
    if (used + len > maxChars && selected.length) break;
    selected.unshift(line);
    used += len;
  }
  return [
    'This HappyWeb session was restored after a service restart. The original Claude Code conversation could not be resumed, so here is a bounded transcript of recent prior turns. Treat it as conversation context for future replies. Reply with only: Restored.',
    '',
    '<transcript>',
    selected.join('\n\n'),
    '</transcript>',
  ].join('\n');
}

function maybeSeedRestoredHistory(session) {
  if (!session.restore?.needsHistorySeed) return;
  if (session.restore.historySeededAt) return;
  if (!session.history.length) return;
  session.restore.historySeededAt = Date.now();
  saveSessionState(session);
  enqueueInternalCommand(session, buildHistoryRestorePrompt(session), { kind: 'history_seed' });
}

function maybeScheduleContextMaintenance(session) {
  if (!session || session.phase !== 'idle' || session._maintenanceQueued) return;
  if (!session.history?.some(entry => entry.role === 'user')) return;
  if (session.context?.needsCompact) {
    enqueueInternalCommand(session, '/compact', { kind: 'compact', priority: true });
    return;
  }
  if (session._messageQueue?.length) return;
  if (isContextCheckDue(session)) {
    enqueueInternalCommand(session, '/context', { kind: 'context_check' });
  }
}

function markInternalComplete(session, kind, response) {
  session._maintenanceQueued = null;
  if (kind === 'context_check') {
    updateContextUsageFromText(session, response || getScreenText(session.vt));
    session.context = { ...(session.context || {}), turnsSinceLastCheck: 0, lastCheckedAt: Date.now() };
  } else if (kind === 'compact') {
    session.context = {
      ...(session.context || {}),
      needsCompact: false,
      turnsSinceLastCheck: 0,
      lastCheckedAt: Date.now(),
      lastCompactedAt: Date.now(),
    };
  }
  saveSessionState(session);
}

function onSessionReady(session, label) {
  session.phase = 'idle';
  session.status = 'idle';
  session.restartCount = 0;
  if (session._lastSpawnUsedResume) session.lastResumeSucceededAt = Date.now();
  discoverClaudeSessionIdFromLocalLogs(session);
  saveSessionState(session);
  log(session.id, label);
  broadcast(session, { type: 'status', status: 'idle', sessionId: session.id });
  broadcastAll({ type: 'sessions', sessions: sessionList() });
  maybeSeedRestoredHistory(session);
  setTimeout(() => {
    maybeScheduleContextMaintenance(session);
    _drainQueue(session);
  }, 1000);
}

function isNoiseLine(line) {
  // Box drawing / decorative lines
  if (/^[─━╭╰╮╯│╌┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬\s]+$/.test(line)) return true;
  // Collapsed tool call indicators
  if (/^⏵⏵/.test(line)) return true;
  // "Using X" model indicator
  if (/^Using\s/.test(line)) return true;
  // Processing/done spinners
  if (/^[✻●⏺◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\w+ing\b/.test(line)) return true;
  if (/^[✻●⏺]\s*\w+ed\s+(in|for)\s+[\d.]+/.test(line)) return true;
  // Interrupt hint
  if (/esc to interrupt/i.test(line)) return true;
  // Token/cost stats
  if (/\d+\s*tokens/.test(line)) return true;
  if (/\$[\d.]+\s*(cost|spent)/i.test(line)) return true;
  if (/context:?\s*[\d.]+[km]?\s*\/\s*[\d.]+[km]?/i.test(line)) return true;
  // Permission/bypass hints
  if (/bypass permissions|shift\+tab/i.test(line)) return true;
  if (/type your message/i.test(line)) return true;
  // Attachment markers (from wecom)
  if (/^\[附件:/.test(line)) return true;
  // Tool call summaries
  if (/^Read \d+ (file|line)/.test(line)) return true;
  if (/^(Listed|Read|Found|Wrote|Created|Executed|Edited|Deleted|Searched|Ran)\s+\d+/.test(line)) return true;
  if (/^(Bash|Read|Write|Edit|Grep|Glob|WebFetch|WebSearch|Agent)\s*[:(]/.test(line)) return true;
  // File path with line numbers (tool output headers)
  if (/^[\/~][\w\/.@-]+:\d+/.test(line)) return true;
  // Progress bars
  if (/[█▓▒░]{3,}/.test(line)) return true;
  // Empty prompt
  if (/^❯\s*$/.test(line)) return true;
  // Prompt with user text (shouldn't be in response)
  if (/^❯\s+\S/.test(line)) return true;
  // Session/model info lines
  if (/^(Model|Session|Mode|Project):?\s/i.test(line)) return true;
  // Compact/context summary lines
  if (/^Compacted\s/i.test(line)) return true;
  if (/auto-compact/i.test(line)) return true;

  return false;
}

function startClaude(session) {
  session.vt = new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
  session.phase = 'init';
  session.status = 'starting';
  session.sentTrustEnter = false;
  session.onDataCount = 0;
  session.lastDetectedType = '';
  session.sawProcessingSinceSent = false;
  session.sentMsgTimeout = null;
  session.sentMsgAbsoluteTimeout = null;
  session.sentMsgScreenHash = null;
  session.screenChangedSinceSent = false;
  session.doneTimer = null;
  session.lastExtractedResponse = null;
  session.pendingCallbacks = [];
  session.currentRequest = null;
  session.claudeSpawnedAt = Date.now();

  const claudePath = process.env.CLAUDE_PATH || '/usr/local/bin/claude';
  const args = ['--permission-mode', 'bypassPermissions'];
  session._lastSpawnUsedResume = Boolean(session.claudeSessionId);
  if (session.claudeSessionId) {
    args.push('--resume', session.claudeSessionId);
    session.lastResumeAttemptAt = Date.now();
    log(session.id, `Spawning Claude CLI from ${claudePath} with --resume ${session.claudeSessionId}...`);
  } else {
    log(session.id, `Spawning Claude CLI from ${claudePath}...`);
  }
  saveSessionState(session);

  const proc = pty.spawn(claudePath, args, {
    name: 'xterm-256color', cols: COLS, rows: ROWS,
    cwd: session.cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  session.ptyProc = proc;

  proc.onData((data) => {
    session.onDataCount++;
    session.lastActivityAt = Date.now();
    session.vt.write(data);
    captureClaudeSessionId(session, data);
    updateContextUsageFromText(session, data);
    if (session.onDataCount <= 5 || session.onDataCount % 50 === 0) {
      const screenType = detectScreenType(getScreenText(session.vt));
      log(session.id, `onData #${session.onDataCount}: len=${data.length}, screenType=${screenType}, phase=${session.phase}`);
    }
    processTick(session);
  });

  proc.onExit(({ exitCode }) => {
    log(session.id, `Exited code=${exitCode}`);
    if (session._destroyed || !sessions.has(session.id)) return;
    const resumeFailed = session._lastSpawnUsedResume && session.phase === 'init' && exitCode !== 0;
    session.ptyProc = null;
    session.status = 'stopped';
    session.phase = 'stopped';
    stopPolling(session);
    if (resumeFailed) {
      log(session.id, `Resume failed for ${session.claudeSessionId}; clearing saved Claude session id`);
      session.claudeSessionId = null;
      session.resumeFailureCount = (session.resumeFailureCount || 0) + 1;
      if (session.history.length) session.restore.needsHistorySeed = true;
      saveSessionState(session);
    }
    broadcast(session, { type: 'exited', code: exitCode, sessionId: session.id });
    broadcastAll({ type: 'sessions', sessions: sessionList() });
    if (!session.restartCount) session.restartCount = 0;
    if (session.restartCount < 3) {
      const delay = Math.min(2000 * Math.pow(2, session.restartCount), 30000);
      session.restartCount++;
      log(session.id, `Auto-restart #${session.restartCount} in ${delay}ms`);
      setTimeout(() => {
        if (session.phase === 'stopped') startClaude(session);
      }, delay);
    } else {
      log(session.id, `Max quick restarts reached, will retry in 5 minutes`);
      setTimeout(() => {
        if (session.phase === 'stopped') {
          session.restartCount = 0;
          startClaude(session);
        }
      }, 300000);
    }
  });

  session.pollTimer = setInterval(() => pollScreen(session), 1000);

  if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
  session.heartbeatTimer = setInterval(() => heartbeatCheck(session), 30000);
  session.lastActivityAt = Date.now();
}

function stopPolling(session) {
  if (session.pollTimer) { clearInterval(session.pollTimer); session.pollTimer = null; }
  if (session.heartbeatTimer) { clearInterval(session.heartbeatTimer); session.heartbeatTimer = null; }
}

function heartbeatCheck(session) {
  if (!session.ptyProc) return;

  // Idle phase: completely normal, no output expected.
  if (session.phase === 'idle') {
    try {
      require('child_process').execSync(`kill -0 ${session.ptyProc.pid}`, { timeout: 2000 });
    } catch(e) {
      log(session.id, 'HEARTBEAT: process dead in idle, restarting');
      restartClaude(session, 'process_dead_in_idle');
    }
    return;
  }

  // Processing or sent_msg: Claude should be active.
  if (session.phase === 'sent_msg' || session.phase === 'processing') {
    const inactiveMs = Date.now() - session.lastActivityAt;

    // If there's been recent activity (within 30s), Claude is working fine
    if (inactiveMs < 30000) return;

    // No activity for 30s+ — diagnose
    const pid = session.ptyProc.pid;
    let alive = false, connections = 0, cpu = '0';
    try {
      require('child_process').execSync(`kill -0 ${pid}`, { timeout: 2000 });
      alive = true;
    } catch(e) {}
    if (!alive) {
      log(session.id, `HEARTBEAT: process dead in ${session.phase}, restarting`);
      restartClaude(session, `process_dead_in_${session.phase}`);
      return;
    }
    try {
      connections = parseInt(require('child_process').execSync(
        `lsof -i -p ${pid} 2>/dev/null | grep -c ESTABLISHED`, { encoding: 'utf8', timeout: 2000 }
      ).trim()) || 0;
    } catch(e) {}
    try {
      cpu = require('child_process').execSync(
        `ps -o %cpu -p ${pid} | tail -1`, { encoding: 'utf8', timeout: 2000 }
      ).trim();
    } catch(e) {}

    // Active network or CPU — still working, just no terminal output
    if (connections > 0 || parseFloat(cpu) > 0.5) {
      log(session.id, `HEARTBEAT: ${session.phase} inactive ${Math.round(inactiveMs/1000)}s but alive (net=${connections}, cpu=${cpu})`);
      return;
    }

    // Check screen — maybe we missed a state transition
    const screenType = detectScreenType(getScreenText(session.vt));
    if (screenType === 'idle') {
      log(session.id, `HEARTBEAT: missed idle transition, finishing response`);
      finishResponse(session, 'heartbeat_idle_recovery');
      return;
    }
    if (screenType === 'processing') {
      // Still shows processing but no activity — give it more time
      if (inactiveMs < 120000) return;
    }

    // Truly stuck: no network, no CPU, no progress for 120s+
    if (inactiveMs >= 120000) {
      log(session.id, `HEARTBEAT: STUCK ${Math.round(inactiveMs/1000)}s, net=${connections}, cpu=${cpu}`);
      diagnoseProcess(session, `stuck_${session.phase}`);
      // Try to extract whatever we have before restarting
      const response = extractResponse(session.vt, session.currentRequest?.text);
      if (response && response !== session.lastExtractedResponse) {
        log(session.id, `HEARTBEAT: salvaging response before restart (${response.length} chars)`);
        finishResponse(session, 'heartbeat_salvage', response);
      }
      restartClaude(session, `stuck_${session.phase}`);
    }
  }
}

function diagnoseProcess(session, reason) {
  const pid = session.ptyProc?.pid;
  if (!pid) { log(session.id, 'DIAG: no PTY pid'); return; }

  log(session.id, `DIAG START (reason=${reason}, pid=${pid})`);

  // 1. Process alive?
  try {
    const { execSync } = require('child_process');
    execSync(`kill -0 ${pid}`, { timeout: 2000 });
    log(session.id, `DIAG: process alive=YES`);
  } catch(e) {
    log(session.id, `DIAG: process alive=NO (${e.message})`);
  }

  // 2. Process state
  try {
    const ps = require('child_process').execSync(
      `ps -o state,etime,rss,%cpu -p ${pid}`, { encoding: 'utf8', timeout: 2000 }
    ).trim();
    log(session.id, `DIAG: ps=${ps.replace(/\n/g, ' | ')}`);
  } catch(e) {}

  // 3. Network connections (is Claude talking to API?)
  try {
    const net = require('child_process').execSync(
      `lsof -i -p ${pid} 2>/dev/null | grep -c ESTABLISHED`, { encoding: 'utf8', timeout: 2000 }
    ).trim();
    log(session.id, `DIAG: ESTABLISHED connections=${net}`);
  } catch(e) {}

  // 4. PTY fd
  try {
    const pty = require('child_process').execSync(
      `lsof -p ${pid} 2>/dev/null | grep -E '(pts|ttys|ptmx)'`, { encoding: 'utf8', timeout: 2000 }
    ).trim();
    log(session.id, `DIAG: PTY fds=${pty.replace(/\n/g, ' | ') || 'none'}`);
  } catch(e) {}

  // 5. Test stdin write
  try {
    session.ptyProc.write('');
    log(session.id, `DIAG: stdin write test=OK`);
  } catch(e) {
    log(session.id, `DIAG: stdin write test=FAIL (${e.message})`);
  }

  // 6. Screen dump (what's on screen right now)
  try {
    const lines = getScreenLines(session.vt);
    const nonEmpty = lines.filter(l => l.trim());
    log(session.id, `DIAG: screen lines=${lines.length}, nonEmpty=${nonEmpty.length}`);
    for (let i = 0; i < Math.min(nonEmpty.length, 10); i++) {
      log(session.id, `DIAG: screen[${i}]=${nonEmpty[i].substring(0, 120)}`);
    }
  } catch(e) {
    log(session.id, `DIAG: screen dump failed: ${e.message}`);
  }

  log(session.id, `DIAG END`);
}

function restartClaude(session, reason) {
  log(session.id, `Restarting Claude (reason: ${reason})`);
  if (session.heartbeatTimer) { clearInterval(session.heartbeatTimer); session.heartbeatTimer = null; }
  if (session.pollTimer) { clearInterval(session.pollTimer); session.pollTimer = null; }
  if (session.ptyProc) {
    try { session.ptyProc.kill(); } catch(_) {}
  }
  session.ptyProc = null;
  session.phase = 'stopped';
  session.status = 'stopped';
  // Trigger restart via onExit callback (which handles backoff)
  // If ptyProc is already null, just start directly
  const delay = Math.min(2000 * Math.pow(2, session.restartCount || 0), 30000);
  session.restartCount = (session.restartCount || 0) + 1;
  log(session.id, `Restart #${session.restartCount} in ${delay}ms`);
  setTimeout(() => {
    if (session.phase === 'stopped') startClaude(session);
  }, delay);
}

function pollScreen(session) {
  if (!session.ptyProc) return;
  const text = getScreenText(session.vt);
  captureClaudeSessionId(session, text);
  updateContextUsageFromText(session, text);
  const screenType = detectScreenType(text);

  if (screenType !== session.lastDetectedType) {
    log(session.id, `POLL: screenType changed: ${session.lastDetectedType} → ${screenType} (phase=${session.phase})`);
    session.lastDetectedType = screenType;
  }

  handleState(session, screenType);
}

function processTick(session) {
  const text = getScreenText(session.vt);
  captureClaudeSessionId(session, text);
  updateContextUsageFromText(session, text);
  const screenType = detectScreenType(text);
  handleState(session, screenType);
}

function handleState(session, screenType) {
  // 1. Trust prompt
  if (screenType === 'trust_prompt' && !session.sentTrustEnter && session.phase === 'init') {
    session.sentTrustEnter = true;
    session.phase = 'waiting_trust';
    log(session.id, 'Trust prompt → sending Enter in 500ms');
    setTimeout(() => {
      if (session.ptyProc) {
        session.ptyProc.write('\r');
        log(session.id, 'Enter sent');
      }
    }, 500);
    return;
  }

  // 2. After trust → idle
  if (session.phase === 'waiting_trust' && screenType === 'idle') {
    onSessionReady(session, 'Claude ready!');
    return;
  }

  // Also handle init → idle directly (no trust prompt needed)
  if (session.phase === 'init' && screenType === 'idle') {
    onSessionReady(session, 'Claude ready (no trust prompt)!');
    return;
  }

  // 3. After user message sent — waiting for Claude to start processing
  if (session.phase === 'sent_msg') {
    if (screenType === 'processing') {
      transitionToProcessing(session);
    } else if (screenType === 'interactive_prompt') {
      transitionToInteractivePrompt(session);
    } else if (screenType === 'idle') {
      // Idle right after sending? Claude responded instantly or message wasn't received.
      // Use stability check to confirm it's truly idle.
      scheduleStabilityCheck(session, 'sent_msg_idle');
    } else if (screenType === 'done') {
      // Done without processing — very fast response
      transitionToProcessing(session);
      scheduleStabilityCheck(session, 'fast_done');
    }

    // Failsafe: if no state change detected within 20s, check screen
    if (!session.sentMsgTimeout) {
      session.sentMsgTimeout = setTimeout(() => {
        session.sentMsgTimeout = null;
        if (session.phase !== 'sent_msg') return;
        const currentType = detectScreenType(getScreenText(session.vt));
        log(session.id, `sent_msg failsafe: screenType=${currentType}`);
        if (currentType === 'idle') {
          finishResponse(session, 'sent_msg_failsafe');
        } else if (currentType === 'processing') {
          transitionToProcessing(session);
        } else if (currentType === 'interactive_prompt') {
          transitionToInteractivePrompt(session);
        }
        // Otherwise keep waiting — heartbeat will handle truly stuck cases
      }, 20000);
    }
    return;
  }

  // 4. During processing — waiting for Claude to finish
  if (session.phase === 'processing') {
    if (screenType === 'processing') {
      // Still working — reset stability timer
      session.lastActivityAt = Date.now();
      if (session.doneTimer) { clearTimeout(session.doneTimer); session.doneTimer = null; }
    } else if (screenType === 'interactive_prompt') {
      transitionToInteractivePrompt(session);
    } else if (screenType === 'idle') {
      // Idle prompt appeared — Claude is done. Short stability check to be sure.
      scheduleStabilityCheck(session, 'processing_to_idle');
    } else if (screenType === 'done') {
      // "Done" between tool calls is transient. Wait for stability.
      scheduleStabilityCheck(session, 'processing_done');
    } else if (screenType === 'unknown') {
      // Unknown state — could be a missed transition. Schedule check.
      scheduleStabilityCheck(session, 'processing_unknown');
    }

    // Safety net: if processing for too long without onData activity, force check
    if (!session._processingWatchdog) {
      session._processingWatchdog = setInterval(() => {
        if (session.phase !== 'processing') {
          clearInterval(session._processingWatchdog);
          session._processingWatchdog = null;
          return;
        }
        const inactiveMs = Date.now() - session.lastActivityAt;
        if (inactiveMs >= 10000) {
          // No terminal output for 10s during processing — likely done
          const currentType = detectScreenType(getScreenText(session.vt));
          log(session.id, `Processing watchdog: inactive ${Math.round(inactiveMs/1000)}s, screenType=${currentType}`);
          if (currentType === 'idle' || currentType === 'done' || currentType === 'unknown') {
            clearInterval(session._processingWatchdog);
            session._processingWatchdog = null;
            finishResponse(session, 'watchdog_inactive');
          } else if (currentType === 'interactive_prompt') {
            transitionToInteractivePrompt(session);
          }
        }
      }, 5000);
    }
    return;
  }
}

function cleanInteractiveLine(line) {
  return String(line || '')
    .replace(/[╭╰╮╯│─━╌┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseInteractiveState(vt) {
  const rawLines = getScreenLines(vt).filter(l => l.trim());
  const lines = rawLines.map(cleanInteractiveLine).filter(Boolean);
  const tail = lines.slice(-30);
  const tailText = tail.join('\n');
  const state = {
    type: 'unknown',
    prompt: '',
    options: [],
    selected: null,
    submitAvailable: /\bSubmit\b/i.test(tailText),
    rawTail: tail,
  };

  if (/\b(Allow|Deny|allow once|allow always|permission|permissions)\b/i.test(tailText) && /\b(Yes|No|Allow|Deny|y\/n)\b/i.test(tailText)) {
    state.type = 'permission';
  } else if (/\b(Yes|No|Confirm|Cancel|确认|取消|继续|拒绝)\b/i.test(tailText) && /[？?]$/.test(tailText.replace(/\n/g, ' '))) {
    state.type = 'confirm';
  }

  for (const line of tail) {
    let match = line.match(/^[❯>→\-*•○●◉☐☑✔\s]*(\d+)[.)、]\s+(.+)$/);
    if (match) {
      state.options.push(match[2].trim());
      if (/^[❯>→]/.test(line)) state.selected = state.options.length - 1;
      continue;
    }
    match = line.match(/^[❯>→\-*•○●◉☐☑✔\s]+([^\s].+)$/);
    if (match && !/^(Submit|Skills|Using|Context Usage)/i.test(match[1])) {
      const option = match[1].trim();
      if (option.length <= 80 && !/[？?]$/.test(option)) {
        state.options.push(option);
        if (/^[❯>→]/.test(line)) state.selected = state.options.length - 1;
      }
    }
  }

  const promptCandidates = tail.filter(line =>
    !/^←/.test(line) &&
    !/^❯\s*\d/.test(line) &&
    !/^\d+[.)、]/.test(line) &&
    !/\bSubmit\b/i.test(line) &&
    !/^(Skills|Using|Context Usage|Opus|claude-)/i.test(line) &&
    (/[？?]$/.test(line) || /用什么|选择|输入|是否|确认|允许|可见性|仓库名/.test(line))
  );
  state.prompt = promptCandidates[promptCandidates.length - 1] || '';

  if (state.type === 'unknown') {
    if (state.options.length > 0) state.type = 'select';
    else if (state.prompt || state.submitAvailable || /❯\s*$/.test(tailText)) state.type = 'text_input';
  }

  state.options = [...new Set(state.options)].slice(0, 8);
  return state;
}

function formatInteractivePrompt(state, response) {
  const parts = [];
  if (response) parts.push(response);
  if (state.prompt && (!response || !response.includes(state.prompt))) parts.push(state.prompt);

  if (state.type === 'permission') {
    parts.push('当前需要权限确认。请回复：允许 / 拒绝，或按界面提示回复具体选项。');
  } else if (state.type === 'confirm') {
    parts.push('当前需要确认。请回复：确认 / 取消，或按界面提示回复具体选项。');
  } else if (state.type === 'select') {
    if (state.options.length) {
      parts.push('当前需要选择一个选项，请回复编号或选项内容：');
      state.options.forEach((option, index) => {
        const marker = state.selected === index ? '（当前选中）' : '';
        parts.push(`${index + 1}. ${option}${marker}`);
      });
    } else {
      parts.push('当前需要选择一个选项，请回复编号或选项内容。');
    }
  } else if (state.type === 'text_input') {
    parts.push('当前需要输入内容，请直接回复要填写的内容。');
  } else {
    parts.push('Claude 正在等待进一步输入，请按当前界面回复下一步内容。');
  }

  if (state.submitAvailable && state.type !== 'text_input') {
    parts.push('如果已选好，也可以回复“确认/提交”。');
  }
  return parts.filter(Boolean).join('\n');
}

function interactivePromptMessage(session, response) {
  return formatInteractivePrompt(parseInteractiveState(session.vt), response);
}

function transitionToInteractivePrompt(session) {
  if (session.doneTimer) { clearTimeout(session.doneTimer); session.doneTimer = null; }
  if (session.sentMsgTimeout) { clearTimeout(session.sentMsgTimeout); session.sentMsgTimeout = null; }
  if (session._processingWatchdog) { clearInterval(session._processingWatchdog); session._processingWatchdog = null; }
  session.phase = 'awaiting_input';
  session.status = 'idle';
  log(session.id, 'Claude is waiting for interactive input');
  broadcast(session, { type: 'status', status: 'idle', sessionId: session.id });
  broadcastAll({ type: 'sessions', sessions: sessionList() });
  const response = extractResponse(session.vt, session.currentRequest?.text);
  if (response && response !== session.lastExtractedResponse) {
    session.lastExtractedResponse = response;
    const request = session.currentRequest || {};
    if (!request.internal && request.persistHistory !== false) {
      const entry = { role: 'assistant', content: response, timestamp: Date.now() };
      session.history.push(entry);
      saveSessionState(session);
      broadcast(session, { type: 'message', ...entry, sessionId: session.id });
    }
    while (session.pendingCallbacks.length > 0) {
      const item = session.pendingCallbacks.shift();
      const cb = typeof item === 'function' ? item : item.cb;
      try { if (cb) cb(interactivePromptMessage(session, response)); } catch(e) { log(session.id, `Callback error: ${e.message}`); }
    }
  } else {
    while (session.pendingCallbacks.length > 0) {
      const item = session.pendingCallbacks.shift();
      const cb = typeof item === 'function' ? item : item.cb;
      try { if (cb) cb(interactivePromptMessage(session, null)); } catch(e) { log(session.id, `Callback error: ${e.message}`); }
    }
  }
  session.currentRequest = null;
  saveSessionState(session);
}

function transitionToProcessing(session) {
  if (session.phase === 'processing') return;
  session.phase = 'processing';
  session.status = 'processing';
  session.sawProcessingSinceSent = true;
  session.lastActivityAt = Date.now();
  if (session.sentMsgTimeout) { clearTimeout(session.sentMsgTimeout); session.sentMsgTimeout = null; }
  if (session.sentMsgAbsoluteTimeout) { clearTimeout(session.sentMsgAbsoluteTimeout); session.sentMsgAbsoluteTimeout = null; }
  if (session.doneTimer) { clearTimeout(session.doneTimer); session.doneTimer = null; }
  log(session.id, 'Processing started');
  broadcast(session, { type: 'status', status: 'processing', sessionId: session.id });
}

/**
 * Schedule a stability check: wait for screen to stop changing, then confirm done.
 * If screen changes during the wait, cancel and let the next processTick handle it.
 */
function scheduleStabilityCheck(session, reason) {
  if (session.doneTimer) return; // already scheduled

  const snapshotHash = getScreenText(session.vt);
  session._stabilitySnapshot = snapshotHash;
  session._stabilityReason = reason;

  session.doneTimer = setTimeout(() => {
    session.doneTimer = null;
    if (session.phase !== 'processing' && session.phase !== 'sent_msg') return;

    const currentScreen = getScreenText(session.vt);
    const currentType = detectScreenType(currentScreen);

    // Screen changed since snapshot — Claude is still working
    if (currentScreen !== session._stabilitySnapshot) {
      log(session.id, `Stability check (${reason}): screen changed, type=${currentType}`);
      // If still processing, just let it continue
      if (currentType === 'processing') {
        session.lastActivityAt = Date.now();
        return;
      }
      // Screen changed but not processing — re-schedule to check again
      scheduleStabilityCheck(session, reason + '_retry');
      return;
    }

    // Screen stable — confirm done
    if (currentType === 'interactive_prompt') {
      log(session.id, `Stability confirmed (${reason}, type=${currentType}): waiting for interactive input`);
      transitionToInteractivePrompt(session);
    } else if (currentType === 'idle' || currentType === 'done' || currentType === 'unknown') {
      log(session.id, `Stability confirmed (${reason}, type=${currentType}): finishing response`);
      finishResponse(session, reason);
    } else if (currentType === 'processing') {
      // Went back to processing — keep waiting
      log(session.id, `Stability check (${reason}): back to processing`);
      session.lastActivityAt = Date.now();
    }
  }, 2000); // 2s stability window
}

function finishResponse(session, reason, preExtracted) {
  session.phase = 'idle';
  session.status = 'idle';
  if (session.sentMsgTimeout) { clearTimeout(session.sentMsgTimeout); session.sentMsgTimeout = null; }
  if (session.sentMsgAbsoluteTimeout) { clearTimeout(session.sentMsgAbsoluteTimeout); session.sentMsgAbsoluteTimeout = null; }
  if (session.doneTimer) { clearTimeout(session.doneTimer); session.doneTimer = null; }
  if (session._processingWatchdog) { clearInterval(session._processingWatchdog); session._processingWatchdog = null; }
  session._stabilitySnapshot = null;
  log(session.id, `Response done (${reason})`);

  const request = session.currentRequest || {};
  session.currentRequest = null;
  const response = preExtracted || extractResponse(session.vt, request.text);
  updateContextUsageFromText(session, response || getScreenText(session.vt));
  discoverClaudeSessionIdFromLocalLogs(session);

  if (response) {
    session.lastExtractedResponse = response;
    session.restartCount = 0;
    log(session.id, `Response (${response.length} chars): ${response.substring(0, 150)}`);
    if (!request.internal && request.persistHistory !== false) {
      const entry = { role: 'assistant', content: response, timestamp: Date.now() };
      session.history.push(entry);
      session.context = {
        ...(session.context || {}),
        turnsSinceLastCheck: (session.context?.turnsSinceLastCheck || 0) + 1,
      };
      saveSessionState(session);
      broadcast(session, { type: 'message', ...entry, sessionId: session.id });
    } else {
      markInternalComplete(session, request.kind, response);
    }

    while (session.pendingCallbacks.length > 0) {
      const item = session.pendingCallbacks.shift();
      const cb = typeof item === 'function' ? item : item.cb;
      if (cb) {
        try { cb(response); } catch(e) { log(session.id, `Callback error: ${e.message}`); }
      }
    }
  } else {
    if (request.internal) {
      markInternalComplete(session, request.kind, null);
      log(session.id, `Internal response had no extractable output (${request.kind})`);
    } else {
      log(session.id, 'No response extracted! Dumping screen:');
      const lines = getScreenLines(session.vt);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim()) log(session.id, `  L${i}: ${lines[i]}`);
      }
    }
    while (session.pendingCallbacks.length > 0) {
      const item = session.pendingCallbacks.shift();
      const cb = typeof item === 'function' ? item : item.cb;
      try { if (cb) cb(null); } catch(e) {}
    }
  }

  saveSessionState(session);
  broadcast(session, { type: 'status', status: 'idle', sessionId: session.id });
  broadcastAll({ type: 'sessions', sessions: sessionList() });

  setTimeout(() => {
    maybeScheduleContextMaintenance(session);
    _drainQueue(session);
  }, 500);
}

function normalizeInteractiveInput(text) {
  const trimmed = String(text || '').trim().toLowerCase();
  if (/^(确认|提交|确定|ok|yes|y)$/.test(trimmed)) return '\r';
  if (/^(取消|不要|否|no|n)$/.test(trimmed)) return '\x1b';
  return null;
}

function sendToClaude(session, text, onComplete, options = {}) {
  if (!session || !session.ptyProc) {
    return { ok: false, error: 'Session not running' };
  }

  if (session.phase === 'awaiting_input' && !options.internal) {
    _sendMessageNow(session, text, onComplete, { ...options, interactiveReply: true });
    return { ok: true };
  }

  if (!options.internal && session.context?.needsCompact && session.phase === 'idle') {
    if (!session._messageQueue) session._messageQueue = [];
    session._messageQueue.push({ text, onComplete, options });
    enqueueInternalCommand(session, '/compact', { kind: 'compact', priority: true });
    log(session.id, `Queued user message behind compaction (queue size: ${session._messageQueue.length})`);
    return { ok: true, queued: true, compacting: true };
  }

  if (session.phase !== 'idle') {
    if (!session._messageQueue) session._messageQueue = [];
    session._messageQueue.push({ text, onComplete, options });
    log(session.id, `Queued message (queue size: ${session._messageQueue.length}): ${text.substring(0, 50)}`);
    return { ok: true, queued: true };
  }

  _sendMessageNow(session, text, onComplete, options);
  return { ok: true };
}

function _sendMessageNow(session, text, onComplete, options = {}) {
  const request = {
    internal: Boolean(options.internal),
    persistHistory: options.persistHistory !== false,
    broadcast: options.broadcast !== false,
    kind: options.kind || 'user',
    interactiveReply: Boolean(options.interactiveReply),
    text,
  };
  session.currentRequest = request;

  if (!request.internal && request.persistHistory) {
    const entry = { role: 'user', content: text, timestamp: Date.now() };
    session.history.push(entry);
    saveSessionState(session);
    if (request.broadcast) broadcast(session, { type: 'message', ...entry, sessionId: session.id });
  }

  session.phase = 'sent_msg';
  session.status = 'processing';
  session.userMsgSentAt = Date.now();
  session.lastActivityAt = Date.now();
  session.sawProcessingSinceSent = false;
  if (session.sentMsgTimeout) { clearTimeout(session.sentMsgTimeout); session.sentMsgTimeout = null; }
  if (session.sentMsgAbsoluteTimeout) { clearTimeout(session.sentMsgAbsoluteTimeout); session.sentMsgAbsoluteTimeout = null; }
  if (session.doneTimer) { clearTimeout(session.doneTimer); session.doneTimer = null; }
  broadcast(session, { type: 'status', status: 'processing', sessionId: session.id });

  log(session.id, `${request.internal ? 'Internal' : 'User'} msg (${request.kind}): ${text.substring(0, 80)}`);

  if (onComplete) {
    session.pendingCallbacks.push({ cb: onComplete, internal: request.internal, kind: request.kind });
  }

  const sanitized = request.interactiveReply && normalizeInteractiveInput(text) !== null
    ? normalizeInteractiveInput(text)
    : text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

  session.ptyProc.write(sanitized);
  const onDataCountBefore = session.onDataCount;
  if (sanitized === '\r' || sanitized === '\x1b') {
    log(session.id, `Interactive key sent: ${sanitized === '\r' ? 'Enter' : 'Escape'}`);
  } else {
    setTimeout(() => {
      if (session.ptyProc) {
        session.ptyProc.write('\r');
        log(session.id, 'Enter sent after msg');
      }
    }, 100);
  }

  log(session.id, `PTY write: msgLen=${sanitized.length}, Enter scheduled in ${sanitized === '\r' || sanitized === '\x1b' ? 0 : 100}ms`);

  setTimeout(() => {
    if (session.onDataCount === onDataCountBefore && session.phase === 'sent_msg') {
      log(session.id, `DIAG: NO onData after 5s! PTY is unresponsive.`);
      diagnoseProcess(session, 'no_ondata_after_send');
    }
  }, 5000);
}

function enqueueInternalCommand(session, text, { kind, priority = false } = {}) {
  if (session._maintenanceQueued === kind || (kind === 'compact' && session._maintenanceQueued === 'compact')) return;
  session._maintenanceQueued = kind || 'internal';
  const item = {
    text,
    onComplete: null,
    options: { internal: true, persistHistory: false, broadcast: false, kind: kind || 'internal' },
  };
  if (!session._messageQueue) session._messageQueue = [];
  if (priority) session._messageQueue.unshift(item);
  else session._messageQueue.push(item);
  if (session.phase === 'idle') _drainQueue(session);
}

function _drainQueue(session) {
  if (!session._messageQueue || session._messageQueue.length === 0) return;
  if (session.phase !== 'idle') return;
  const next = session._messageQueue.shift();
  log(session.id, `Draining queue (remaining: ${session._messageQueue.length}): ${next.text.substring(0, 50)}`);
  _sendMessageNow(session, next.text, next.onComplete, next.options || {});
}

/**
 * Send a key command to Claude (Ctrl+C, etc.)
 */
function sendKeyToClaude(session, key) {
  if (!session || !session.ptyProc) return { ok: false, error: 'Not running' };
  if (key === 'ctrl+c') {
    session.ptyProc.write('\x03');
    log(session.id, 'Sent Ctrl+C');
    return { ok: true };
  }
  if (key === 'shift+tab') {
    session.ptyProc.write('\x1b[Z');
    log(session.id, 'Sent Shift+Tab');
    return { ok: true };
  }
  return { ok: false, error: 'Unknown key' };
}

/**
 * Pre-warm a Claude session at startup so first user message is instant.
 * Returns the session object. Caller should store it for later assignment.
 */
function warmupSession(id, cwd) {
  const session = createSession(id, cwd, { durable: false });
  startClaude(session);
  log(id, 'Warmup session started');
  return session;
}

module.exports = {
  createSession, sessions, sessionList, broadcast, broadcastAll,
  startClaude, stopPolling, log, sendToClaude, sendKeyToClaude,
  warmupSession, restorePersistedSessions, destroySession, saveSessionState,
  getScreenLines, getViewportLines, getScreenText, detectScreenType, extractResponse,
  parseContextUsage, updateContextUsageFromText,
  COLS, ROWS, UPLOAD_DIR, LOG_FILE,
};
