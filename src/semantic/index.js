const EventEmitter = require('events');
const crypto = require('crypto');
const { AgentState } = require('./event-types');
const { ClaudeAgent } = require('../cli-agent');
const StateMachine = require('./state-machine');
const { extractResponse } = require('./response-extractor');
const { parseInteractiveState, formatInteractivePrompt, normalizeInteractiveInput } = require('./prompt-detector');
const { homedir } = require('../shared/platform');
const { log: defaultLog } = require('../shared/logger');

class SemanticSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = options.id || `session_${Date.now().toString(36)}`;
    this.cwd = options.cwd || homedir();
    this.phase = AgentState.INIT;
    this.status = 'starting';
    this.history = options.history || [];
    this.context = options.context || {};
    // Own the Claude session id from the start: reuse a restored one, otherwise
    // generate it now. Passed to the CLI as --session-id on a fresh spawn so it
    // is known up front and can be persisted for --resume after a restart.
    // True only when the id was restored from disk — then we resume the prior
    // conversation. A freshly generated id has no conversation yet, so it spawns
    // fresh (the CLI creates the conversation under our --session-id).
    this._restoredSession = Boolean(options.claudeSessionId);
    this.claudeSessionId = options.claudeSessionId || crypto.randomUUID();
    this.sentTrustEnter = false;
    this.lastExtractedResponse = null;
    this.interactiveState = null;
    this.currentRequest = null;
    this.pendingCallbacks = [];
    this._messageQueue = [];
    this._log = options.log || ((msg) => defaultLog(this.id, msg));

    this.agent = new ClaudeAgent({
      cwd: this.cwd,
      claudePath: options.claudePath,
      claudeSessionId: this.claudeSessionId,
      appendSystemPrompt: options.appendSystemPrompt || null,
    });

    this.stateMachine = new StateMachine(this, {
      log: (msg) => this._log(msg),
      onReady: (label) => this._onReady(label),
      onFinish: (reason) => this._finishResponse(reason),
      onInteractive: () => this._transitionToInteractive(),
      onProcessing: () => this._transitionToProcessing(),
    });

    this._bindAgentEvents();
  }

  // Public API
  start() {
    if (this._restoredSession && this.claudeSessionId) {
      this.agent.spawnWithResume(this.claudeSessionId);
    } else {
      this.agent.spawnFresh();
    }
    this.emit('state-change', { from: null, to: this.phase });
  }

  sendMessage(text, onComplete, options = {}) {
    if (!this.agent.alive) {
      return { ok: false, error: 'Session not running' };
    }

    if (this.phase === AgentState.AWAITING_INPUT && !options.internal) {
      this._sendInteractiveReply(text, onComplete, options);
      return { ok: true };
    }

    if (this.phase !== AgentState.IDLE) {
      this._messageQueue.push({ text, onComplete, options });
      this._log(`Queued message (queue size: ${this._messageQueue.length}): ${text.substring(0, 50)}`);
      return { ok: true, queued: true };
    }

    this._sendNow(text, onComplete, options);
    return { ok: true };
  }

  sendKey(key) {
    if (!this.agent.alive) return { ok: false, error: 'Not running' };
    if (key === 'ctrl+c') { this.agent.interrupt(); return { ok: true }; }
    if (key === 'shift+tab') { this.agent.sendShiftTab(); return { ok: true }; }
    if (key === 'escape') { this.agent.sendEscape(); return { ok: true }; }
    return { ok: false, error: 'Unknown key' };
  }

  destroy() {
    this.stateMachine.clearTimers();
    this.agent.kill();
    this.phase = AgentState.STOPPED;
    this.emit('state-change', { from: this.phase, to: AgentState.STOPPED });
  }

  get state() { return this.phase; }

  // Internal
  _bindAgentEvents() {
    this.agent.on('screen-update', ({ screenType }) => {
      this.stateMachine.tick();
    });

    this.agent.on('screen-change', ({ screenType }) => {
      this.stateMachine.tick();
    });

    this.agent.on('exit', ({ exitCode }) => {
      this._log(`Agent exited code=${exitCode} phase=${this.phase}`);
      // A resume spawn that exits non-zero before we ever reached a working state
      // means the stored conversation is gone. Use spawnUsedResume (reliable) and
      // "never became idle" rather than a specific phase, which a stray screen
      // tick can move off INIT before this fires.
      const neverReady = this.phase !== AgentState.IDLE && this.phase !== AgentState.AWAITING_INPUT;
      const resumeFailed = this.agent.spawnUsedResume && neverReady && exitCode !== 0;
      this.phase = AgentState.STOPPED;
      this.status = 'stopped';
      this.emit('state-change', { from: this.phase, to: AgentState.STOPPED });
      this.emit('exit', { exitCode, resumeFailed });

      if (resumeFailed) {
        // The stored conversation is gone from Claude's local store (e.g. it was
        // cleaned up). Don't let a stale id brick the session: drop it, generate
        // a new one, and respawn fresh so the user can keep chatting (context is
        // lost, but the session works).
        this._log('Resume failed — starting a fresh conversation (prior context lost)');
        this.claudeSessionId = crypto.randomUUID();
        this.agent.claudeSessionId = this.claudeSessionId;
        this._restoredSession = false;
        this.phase = AgentState.INIT;
        this.status = 'starting';
        this.sentTrustEnter = false;
        this.emit('session-id-captured', this.claudeSessionId);
        setTimeout(() => { if (this.agent && !this.agent._destroyed) this.agent.spawnFresh(); }, 500);
      }
    });

    this.agent.on('process-dead', () => {
      this._log('Process dead detected by heartbeat');
      this.agent.restart();
    });

    this.agent.on('output', (data) => {
      this.emit('output', data);
    });
  }

  _onReady(label) {
    const prev = this.phase;
    this.phase = AgentState.IDLE;
    this.status = 'idle';
    this.agent.resetRestartCount();
    this._log(label);
    this.emit('state-change', { from: prev, to: AgentState.IDLE });
    this.emit('ready');
    setTimeout(() => this._drainQueue(), 1000);
  }

  _transitionToProcessing() {
    if (this.phase === AgentState.PROCESSING) return;
    const prev = this.phase;
    this.phase = AgentState.PROCESSING;
    this.status = 'processing';
    this.stateMachine.clearTimers();
    this._log('Processing started');
    this.emit('state-change', { from: prev, to: AgentState.PROCESSING });
  }

  _transitionToInteractive() {
    this.stateMachine.clearTimers();
    const prev = this.phase;
    this.phase = AgentState.AWAITING_INPUT;
    this.status = 'idle';
    this._log('Claude is waiting for interactive input');

    const response = extractResponse(this.agent.vt, this.currentRequest?.text);
    const interactiveState = parseInteractiveState(this.agent.vt);
    const message = formatInteractivePrompt(interactiveState, response);
    this.interactiveState = interactiveState;

    if (response && response !== this.lastExtractedResponse) {
      this.lastExtractedResponse = response;
      this._recordAssistantMessage(response);
    }

    this._invokeCallbacks(message);
    this.currentRequest = null;
    this.emit('state-change', { from: prev, to: AgentState.AWAITING_INPUT });
    this.emit('interactive-prompt', { state: interactiveState, response, message });
  }

  _finishResponse(reason) {
    this.stateMachine.clearTimers();
    const prev = this.phase;
    this.phase = AgentState.IDLE;
    this.status = 'idle';
    this.interactiveState = null;
    this._log(`Response done (${reason})`);

    const request = this.currentRequest || {};
    this.currentRequest = null;
    const response = extractResponse(this.agent.vt, request.text);

    if (response) {
      this.lastExtractedResponse = response;
      this.agent.resetRestartCount();
      this._log(`Response (${response.length} chars): ${response.substring(0, 150)}`);
      if (!request.internal && request.persistHistory !== false) {
        this._recordAssistantMessage(response);
      }
      this._invokeCallbacks(response);
    } else {
      this._log('No response extracted');
      this._invokeCallbacks(null);
    }

    this.emit('state-change', { from: prev, to: AgentState.IDLE });
    this.emit('response-complete', { text: response, reason });
    setTimeout(() => {
      this._drainQueue();
    }, 500);
  }

  _sendNow(text, onComplete, options = {}) {
    const request = {
      internal: Boolean(options.internal),
      persistHistory: options.persistHistory !== false,
      kind: options.kind || 'user',
      text,
    };
    this.currentRequest = request;

    if (!request.internal && request.persistHistory) {
      const entry = { role: 'user', content: text, timestamp: Date.now() };
      this.history.push(entry);
      this.emit('user-message', entry);
    }

    const prev = this.phase;
    this.phase = AgentState.SENT_MSG;
    this.status = 'processing';
    this.emit('state-change', { from: prev, to: AgentState.SENT_MSG });

    this._log(`${request.internal ? 'Internal' : 'User'} msg (${request.kind}): ${text.substring(0, 80)}`);

    if (onComplete) {
      this.pendingCallbacks.push({ cb: onComplete, internal: request.internal, kind: request.kind });
    }

    const sanitized = text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    this.agent.write(sanitized);
    setTimeout(() => { if (this.agent.alive) this.agent.sendEnter(); }, 100);
  }

  // Deliver a reply while Claude is showing an interactive prompt, WITHOUT going
  // through the normal SENT_MSG flip. Flipping early let the state machine tick
  // on the still-open menu and race the multi-step arrow navigation (the cursor
  // desynced and the wrong row got confirmed). Instead we stay in AWAITING_INPUT,
  // pause the state machine, send the keystrokes, and only transition to
  // PROCESSING after the confirming Enter — so the next response is captured.
  _sendInteractiveReply(text, onComplete, options = {}) {
    this.stateMachine.clearTimers();   // no ticks while we navigate the menu
    this._interactiveBusy = true;      // suspend state-machine ticks during nav

    const request = { internal: false, persistHistory: options.persistHistory !== false, kind: 'user', text };
    this.currentRequest = request;
    if (request.persistHistory) {
      const entry = { role: 'user', content: text, timestamp: Date.now() };
      this.history.push(entry);
      this.emit('user-message', entry);
    }
    if (onComplete) this.pendingCallbacks.push({ cb: onComplete, internal: false, kind: 'user' });
    this._log(`Interactive reply: ${String(text).substring(0, 60)}`);

    // After the keystrokes are committed, resume ticks and move to PROCESSING so
    // the resulting response (or the next interactive step) is detected. Use the
    // normal transition (logs "Processing started", clears stale timers) and kick
    // a tick so the watchdog/stability machinery engages immediately instead of
    // waiting for the next PTY event — that wait is what made replies feel slow.
    const commit = () => {
      this._interactiveBusy = false;
      this.agent.lastActivityAt = Date.now();   // fresh, so the watchdog doesn't fire early
      this._transitionToProcessing();
      this.stateMachine.tick();
    };

    const control = normalizeInteractiveInput(text);
    if (control === '\r') { this.agent.sendEnter(); setTimeout(commit, 150); return; }
    if (control === '\x1b') { this.agent.sendEscape(); setTimeout(commit, 150); return; }

    const numMatch = String(text).trim().match(/^(\d+)$/);
    if (numMatch) {
      const live = parseInteractiveState(this.agent.vt);
      if (live.type === 'select' && live.options.length) {
        const target = parseInt(numMatch[1], 10) - 1;
        if (target >= 0 && target < live.options.length) {
          const from = live.selected == null ? 0 : live.selected;
          this._log(`Interactive select: ${numMatch[1]} (from ${from} to ${target} of ${live.options.length})`);
          this._navigateAndConfirm(from, target, commit);
          return;
        }
        this._log(`Interactive select out of range: ${numMatch[1]} (have ${live.options.length})`);
      }
    }

    // Free-text reply into a text-input prompt.
    const sanitized = String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
    this.agent.write(sanitized);
    setTimeout(() => { if (this.agent.alive) this.agent.sendEnter(); setTimeout(commit, 150); }, 100);
  }

  // Move the menu cursor to `to` by sending one arrow key at a time and
  // re-reading the live cursor after each, instead of firing a fixed burst.
  // ConPTY drops/coalesces rapid keystrokes, so an open-loop burst lands on the
  // wrong row; a verified step loop is reliable. Confirms once on arrival, then
  // calls onDone (to transition state) after the Enter is sent.
  _navigateAndConfirm(from, to, onDone) {
    const maxSteps = 24;          // safety bound (menu len + slack)
    let steps = 0;
    const stepOnce = () => {
      if (!this.agent.alive) { if (onDone) onDone(); return; }
      const live = parseInteractiveState(this.agent.vt);
      const cur = live.selected == null ? from : live.selected;
      if (cur === to || steps >= maxSteps) {
        this._log(`Interactive confirm at row ${cur} (target ${to}, ${steps} steps)`);
        this.agent.sendEnter();
        if (onDone) setTimeout(onDone, 150);
        return;
      }
      if (to > cur) this.agent.sendArrowDown(); else this.agent.sendArrowUp();
      steps++;
      setTimeout(stepOnce, 250);   // give ConPTY time to render the moved cursor
    };
    setTimeout(stepOnce, 200);     // let the menu settle before the first read
  }

  _drainQueue() {
    if (!this._messageQueue.length) return;
    if (this.phase !== AgentState.IDLE) return;
    const next = this._messageQueue.shift();
    this._log(`Draining queue (remaining: ${this._messageQueue.length}): ${next.text.substring(0, 50)}`);
    this._sendNow(next.text, next.onComplete, next.options || {});
  }

  _invokeCallbacks(response) {
    while (this.pendingCallbacks.length > 0) {
      const item = this.pendingCallbacks.shift();
      const cb = typeof item === 'function' ? item : item.cb;
      try { if (cb) cb(response); } catch (e) { this._log(`Callback error: ${e.message}`); }
    }
  }

  _recordAssistantMessage(content) {
    const entry = { role: 'assistant', content, timestamp: Date.now() };
    this.history.push(entry);
    this.emit('assistant-message', entry);
  }
}

module.exports = { SemanticSession, AgentState };
