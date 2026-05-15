const EventEmitter = require('events');
const pty = require('node-pty');
const { execSync } = require('child_process');
const { createTerminal, getScreenText, getScreenLines, getViewportLines, detectScreenType, COLS, ROWS } = require('./screen-parser');
const { IS_WIN, homedir, shellEnv } = require('../shared/platform');

class PtyProcess extends EventEmitter {
  constructor(options = {}) {
    super();
    this.claudePath = options.claudePath || process.env.CLAUDE_PATH || (IS_WIN ? 'claude.cmd' : '/usr/local/bin/claude');
    this.cwd = options.cwd || homedir();
    this.claudeArgs = options.claudeArgs || ['--permission-mode', 'bypassPermissions'];
    this.env = { ...shellEnv(), ...(options.env || {}) };

    this.proc = null;
    this.vt = null;
    this.pid = null;
    this.lastActivityAt = 0;
    this.onDataCount = 0;
    this._destroyed = false;

    this._pollTimer = null;
    this._heartbeatTimer = null;
    this._restartCount = 0;
    this._lastDetectedType = '';
  }

  get alive() {
    return this.proc !== null && !this._destroyed;
  }

  spawn(extraArgs = []) {
    if (this._destroyed) return;
    this.vt = createTerminal();
    this.onDataCount = 0;
    this.lastActivityAt = Date.now();

    const args = [...this.claudeArgs, ...extraArgs];
    this.proc = pty.spawn(this.claudePath, args, {
      name: 'xterm-256color',
      cols: COLS,
      rows: ROWS,
      cwd: this.cwd,
      env: this.env,
    });
    this.pid = this.proc.pid;

    this.proc.onData((data) => {
      this.onDataCount++;
      this.lastActivityAt = Date.now();
      this.vt.write(data);
      this.emit('output', data);

      const screenType = detectScreenType(getScreenText(this.vt));
      if (screenType !== this._lastDetectedType) {
        this._lastDetectedType = screenType;
        this.emit('screen-change', { screenType, text: getScreenText(this.vt) });
      }
      this.emit('screen-update', { screenType });
    });

    this.proc.onExit(({ exitCode, signal }) => {
      const proc = this.proc;
      this.proc = null;
      this.pid = null;
      this.emit('exit', { exitCode, signal });
    });

    this._startPolling();
    this._startHeartbeat();
    this.emit('spawn', { pid: this.pid, args });
  }

  write(text) {
    if (!this.proc) return false;
    this.proc.write(text);
    return true;
  }

  interrupt() {
    return this.write('\x03');
  }

  sendShiftTab() {
    return this.write('\x1b[Z');
  }

  sendEscape() {
    return this.write('\x1b');
  }

  sendEnter() {
    return this.write('\r');
  }

  resize(cols, rows) {
    if (this.proc) this.proc.resize(cols, rows);
    if (this.vt) this.vt.resize(cols, rows);
  }

  kill() {
    this._destroyed = true;
    this._stopTimers();
    if (this.proc) {
      try { this.proc.kill(); } catch (_) {}
      this.proc = null;
      this.pid = null;
    }
  }

  restart(extraArgs = []) {
    this._stopTimers();
    if (this.proc) {
      try { this.proc.kill(); } catch (_) {}
      this.proc = null;
      this.pid = null;
    }
    this._destroyed = false;
    const delay = Math.min(2000 * Math.pow(2, this._restartCount), 30000);
    this._restartCount++;
    this.emit('restarting', { attempt: this._restartCount, delayMs: delay });
    setTimeout(() => {
      if (!this._destroyed) this.spawn(extraArgs);
    }, delay);
  }

  resetRestartCount() {
    this._restartCount = 0;
  }

  // Screen access
  getScreenText() { return getScreenText(this.vt); }
  getScreenLines() { return getScreenLines(this.vt); }
  getViewportLines() { return getViewportLines(this.vt); }
  detectScreenType() { return detectScreenType(getScreenText(this.vt)); }

  // Health check
  isProcessAlive() {
    if (!this.pid) return false;
    try {
      process.kill(this.pid, 0);
      return true;
    } catch (_) {
      return false;
    }
  }

  getProcessDiagnostics() {
    if (!this.pid) return { alive: false };
    const diag = { alive: this.isProcessAlive(), pid: this.pid };
    if (IS_WIN) {
      try {
        const out = execSync(
          `tasklist /FI "PID eq ${this.pid}" /FO CSV /NH`,
          { encoding: 'utf8', timeout: 3000 }
        ).trim();
        diag.running = !out.includes('No tasks');
      } catch (_) { diag.running = false; }
      diag.connections = 0;
      diag.cpu = 0;
    } else {
      try {
        diag.connections = parseInt(execSync(
          `lsof -i -p ${this.pid} 2>/dev/null | grep -c ESTABLISHED`,
          { encoding: 'utf8', timeout: 2000 }
        ).trim()) || 0;
      } catch (_) { diag.connections = 0; }
      try {
        diag.cpu = parseFloat(execSync(
          `ps -o %cpu -p ${this.pid} | tail -1`,
          { encoding: 'utf8', timeout: 2000 }
        ).trim()) || 0;
      } catch (_) { diag.cpu = 0; }
    }
    return diag;
  }

  // Internal timers
  _startPolling() {
    this._pollTimer = setInterval(() => {
      if (!this.proc) return;
      const screenType = detectScreenType(getScreenText(this.vt));
      if (screenType !== this._lastDetectedType) {
        this._lastDetectedType = screenType;
        this.emit('screen-change', { screenType, text: getScreenText(this.vt) });
      }
    }, 1000);
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(() => {
      if (!this.proc) return;
      if (!this.isProcessAlive()) {
        this.emit('process-dead');
      }
    }, 30000);
  }

  _stopTimers() {
    if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
  }
}

module.exports = PtyProcess;
