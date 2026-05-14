const fs = require('fs');
const path = require('path');
const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const COLS = 120, ROWS = 200;
const SCROLLBACK = 5000;
const LOG_FILE = '/tmp/happyweb-debug.log';
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Clear log on start
try { fs.writeFileSync(LOG_FILE, ''); } catch(_) {}

function log(id, msg) {
  const line = `${new Date().toISOString()} [${id}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (_) {}
}

const sessions = new Map();

function createSession(id, cwd) {
  const s = {
    id, ptyProc: null,
    vt: new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true }),
    clients: new Set(), status: 'starting', history: [],
    cwd: cwd || process.env.HOME, created: Date.now(),
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
    // For external callers (wecom.js) waiting on response
    pendingCallbacks: [],
  };
  sessions.set(id, s);
  return s;
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

  // Permission prompt (waiting for user approval)
  if (/Allow|Deny|allow once|allow always/i.test(text) && /\(y\/n\)|Yes.*No/i.test(text)) {
    return 'permission_prompt';
  }

  // Check last few lines for UI state (avoids matching response text)
  const lines = text.split('\n');
  const nonEmptyLines = lines.filter(l => l.trim());
  const tail = nonEmptyLines.slice(-15).join('\n');

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

function extractResponse(vt) {
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
  for (let i = searchStart; i >= 0; i--) {
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

  const claudePath = process.env.CLAUDE_PATH || '/usr/local/bin/claude';
  log(session.id, `Spawning Claude CLI from ${claudePath}...`);

  const proc = pty.spawn(claudePath, [
    '--permission-mode', 'bypassPermissions',
  ], {
    name: 'xterm-256color', cols: COLS, rows: ROWS,
    cwd: session.cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  session.ptyProc = proc;

  proc.onData((data) => {
    session.onDataCount++;
    session.lastActivityAt = Date.now();
    session.vt.write(data);
    if (session.onDataCount <= 5 || session.onDataCount % 50 === 0) {
      const screenType = detectScreenType(getScreenText(session.vt));
      log(session.id, `onData #${session.onDataCount}: len=${data.length}, screenType=${screenType}, phase=${session.phase}`);
    }
    processTick(session);
  });

  proc.onExit(({ exitCode }) => {
    log(session.id, `Exited code=${exitCode}`);
    session.ptyProc = null;
    session.status = 'stopped';
    session.phase = 'stopped';
    stopPolling(session);
    broadcast(session, { type: 'exited', code: exitCode, sessionId: session.id });
    broadcastAll({ type: 'sessions', sessions: sessionList() });
    // Auto-restart with exponential backoff
    if (!session.restartCount) session.restartCount = 0;
    if (session.restartCount < 3) {
      const delay = Math.min(2000 * Math.pow(2, session.restartCount), 30000);
      session.restartCount++;
      log(session.id, `Auto-restart #${session.restartCount} in ${delay}ms`);
      setTimeout(() => {
        if (session.phase === 'stopped') startClaude(session);
      }, delay);
    } else {
      // Don't give up forever — retry every 5 minutes
      log(session.id, `Max quick restarts reached, will retry in 5 minutes`);
      setTimeout(() => {
        if (session.phase === 'stopped') {
          session.restartCount = 0;
          startClaude(session);
        }
      }, 300000);
    }
  });

  // Start polling timer as backup detection
  session.pollTimer = setInterval(() => pollScreen(session), 1000);

  // Start heartbeat — detects alive-but-stuck Claude processes
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
      const response = extractResponse(session.vt);
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
  const screenType = detectScreenType(text);

  if (screenType !== session.lastDetectedType) {
    log(session.id, `POLL: screenType changed: ${session.lastDetectedType} → ${screenType} (phase=${session.phase})`);
    session.lastDetectedType = screenType;
  }

  handleState(session, screenType);
}

function processTick(session) {
  const text = getScreenText(session.vt);
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
    session.phase = 'idle';
    session.status = 'idle';
    session.restartCount = 0;
    log(session.id, 'Claude ready!');
    broadcast(session, { type: 'status', status: 'idle', sessionId: session.id });
    broadcastAll({ type: 'sessions', sessions: sessionList() });
    return;
  }

  // Also handle init → idle directly (no trust prompt needed)
  if (session.phase === 'init' && screenType === 'idle') {
    session.phase = 'idle';
    session.status = 'idle';
    session.restartCount = 0;
    log(session.id, 'Claude ready (no trust prompt)!');
    broadcast(session, { type: 'status', status: 'idle', sessionId: session.id });
    broadcastAll({ type: 'sessions', sessions: sessionList() });
    return;
  }

  // 3. After user message sent — waiting for Claude to start processing
  if (session.phase === 'sent_msg') {
    if (screenType === 'processing') {
      transitionToProcessing(session);
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
          }
        }
      }, 5000);
    }
    return;
  }
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
    if (currentType === 'idle' || currentType === 'done' || currentType === 'unknown') {
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

  // Use pre-extracted response to avoid race condition where screen changes
  // between the caller's extractResponse and this one
  const response = preExtracted || extractResponse(session.vt);
  if (response) {
    session.lastExtractedResponse = response;
    session.restartCount = 0;  // Successful response — reset restart counter
    log(session.id, `Response (${response.length} chars): ${response.substring(0, 150)}`);
    const entry = { role: 'assistant', content: response, timestamp: Date.now() };
    session.history.push(entry);
    broadcast(session, { type: 'message', ...entry, sessionId: session.id });

    // Notify external callers (wecom.js)
    while (session.pendingCallbacks.length > 0) {
      const cb = session.pendingCallbacks.shift();
      try { cb(response); } catch(e) { log(session.id, `Callback error: ${e.message}`); }
    }
  } else {
    log(session.id, 'No response extracted! Dumping screen:');
    const lines = getScreenLines(session.vt);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim()) log(session.id, `  L${i}: ${lines[i]}`);
    }
    // Still notify callbacks with empty response so they don't hang
    while (session.pendingCallbacks.length > 0) {
      const cb = session.pendingCallbacks.shift();
      try { cb(null); } catch(e) {}
    }
  }

  broadcast(session, { type: 'status', status: 'idle', sessionId: session.id });
  broadcastAll({ type: 'sessions', sessions: sessionList() });

  // Process next queued message if any
  setTimeout(() => _drainQueue(session), 500);
}

/**
 * Send a message to Claude and get the response via callback.
 * Used by wecom.js for enterprise WeChat integration.
 * @param {object} session - Claude session object
 * @param {string} text - Message text to send
 * @param {function} onComplete - callback(responseText | null)
 * @returns {{ ok: boolean, error?: string }}
 */
function sendToClaude(session, text, onComplete) {
  if (!session || !session.ptyProc) {
    return { ok: false, error: 'Session not running' };
  }

  // Queue message if busy
  if (session.phase !== 'idle') {
    if (!session._messageQueue) session._messageQueue = [];
    session._messageQueue.push({ text, onComplete });
    log(session.id, `Queued message (queue size: ${session._messageQueue.length}): ${text.substring(0, 50)}`);
    return { ok: true, queued: true };
  }

  _sendMessageNow(session, text, onComplete);
  return { ok: true };
}

function _sendMessageNow(session, text, onComplete) {
  // Push user message
  session.history.push({ role: 'user', content: text, timestamp: Date.now() });
  broadcast(session, { type: 'message', role: 'user', content: text, timestamp: Date.now(), sessionId: session.id });

  // Set phase
  session.phase = 'sent_msg';
  session.status = 'processing';
  session.userMsgSentAt = Date.now();
  session.lastActivityAt = Date.now();
  session.sawProcessingSinceSent = false;
  if (session.sentMsgTimeout) { clearTimeout(session.sentMsgTimeout); session.sentMsgTimeout = null; }
  if (session.sentMsgAbsoluteTimeout) { clearTimeout(session.sentMsgAbsoluteTimeout); session.sentMsgAbsoluteTimeout = null; }
  if (session.doneTimer) { clearTimeout(session.doneTimer); session.doneTimer = null; }
  broadcast(session, { type: 'status', status: 'processing', sessionId: session.id });

  log(session.id, `User msg (via wecom): ${text.substring(0, 80)}`);

  // Register callback
  if (onComplete) {
    session.pendingCallbacks.push(onComplete);
  }

  // Sanitize text: escape control chars that could mess up the PTY
  const sanitized = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

  // Write text + Enter (separated by 100ms)
  session.ptyProc.write(sanitized);
  const onDataCountBefore = session.onDataCount;
  setTimeout(() => {
    if (session.ptyProc) {
      session.ptyProc.write('\r');
      log(session.id, 'Enter sent after msg');
    }
  }, 100);

  log(session.id, `PTY write: msgLen=${sanitized.length}, Enter scheduled in 100ms`);

  // Diagnostic: if no onData within 5s after write, Claude is stuck
  setTimeout(() => {
    if (session.onDataCount === onDataCountBefore && session.phase === 'sent_msg') {
      log(session.id, `DIAG: NO onData after 5s! PTY is unresponsive.`);
      diagnoseProcess(session, 'no_ondata_after_send');
    }
  }, 5000);
}

function _drainQueue(session) {
  if (!session._messageQueue || session._messageQueue.length === 0) return;
  if (session.phase !== 'idle') return;
  const next = session._messageQueue.shift();
  log(session.id, `Draining queue (remaining: ${session._messageQueue.length}): ${next.text.substring(0, 50)}`);
  _sendMessageNow(session, next.text, next.onComplete);
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
  const session = createSession(id, cwd);
  startClaude(session);
  log(id, 'Warmup session started');
  return session;
}

module.exports = {
  createSession, sessions, sessionList, broadcast, broadcastAll,
  startClaude, stopPolling, log, sendToClaude, sendKeyToClaude,
  warmupSession,
  getScreenLines, getViewportLines, getScreenText, detectScreenType, extractResponse,
  COLS, ROWS, UPLOAD_DIR, LOG_FILE,
};
