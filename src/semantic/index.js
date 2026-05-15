const EventEmitter = require('events');
const { AgentState } = require('./event-types');
const { ClaudeAgent } = require('../cli-agent');
const StateMachine = require('./state-machine');
const { extractResponse } = require('./response-extractor');
const { parseInteractiveState, formatInteractivePrompt, normalizeInteractiveInput } = require('./prompt-detector');
const { log: defaultLog } = require('../shared/logger');

class SemanticSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.id = options.id || `session_${Date.now().toString(36)}`;
    this.cwd = options.cwd || process.env.HOME;
    this.phase = AgentState.INIT;
    this.status = 'starting';
    this.history = options.history || [];
    this.context = options.context || {};
    this.claudeSessionId = options.claudeSessionId || null;
    this.sentTrustEnter = false;
    this.lastExtractedResponse = null;
    this.currentRequest = null;
    this.pendingCallbacks = [];
    this._messageQueue = [];
    this._log = options.log || ((msg) => defaultLog(this.id, msg));

    this.agent = new ClaudeAgent({
      cwd: this.cwd,
      claudePath: options.claudePath,
      claudeSessionId: this.claudeSessionId,
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
    if (this.claudeSessionId) {
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
      this._sendNow(text, onComplete, { ...options, interactiveReply: true });
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

    this.agent.on('exit', ({ exitCode }) => {
      this._log(`Agent exited code=${exitCode}`);
      const resumeFailed = this.agent.spawnUsedResume && this.phase === AgentState.INIT && exitCode !== 0;
      if (resumeFailed) {
        this._log('Resume failed, clearing Claude session id');
        this.claudeSessionId = null;
        this.agent.claudeSessionId = null;
      }
      this.phase = AgentState.STOPPED;
      this.status = 'stopped';
      this.emit('state-change', { from: this.phase, to: AgentState.STOPPED });
      this.emit('exit', { exitCode, resumeFailed });
    });

    this.agent.on('process-dead', () => {
      this._log('Process dead detected by heartbeat');
      this.agent.restart();
    });

    this.agent.on('output', (data) => {
      this._captureClaudeSessionId(data);
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
    setTimeout(() => this._drainQueue(), 500);
  }

  _sendNow(text, onComplete, options = {}) {
    const request = {
      internal: Boolean(options.internal),
      persistHistory: options.persistHistory !== false,
      interactiveReply: Boolean(options.interactiveReply),
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

    const sanitized = request.interactiveReply && normalizeInteractiveInput(text) !== null
      ? normalizeInteractiveInput(text)
      : text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

    this.agent.write(sanitized);
    if (sanitized !== '\r' && sanitized !== '\x1b') {
      setTimeout(() => { if (this.agent.alive) this.agent.sendEnter(); }, 100);
    }
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

  _captureClaudeSessionId(text) {
    if (!text) return;
    const match = text.match(/\b(?:Session(?:\s+ID)?|sessionId|conversation(?:\s+ID)?)[:"\s]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i);
    if (match && match[1] !== this.claudeSessionId) {
      this.claudeSessionId = match[1];
      this.agent.claudeSessionId = match[1];
      this._log(`Captured Claude session id: ${match[1]}`);
      this.emit('session-id-captured', match[1]);
    }
  }
}

module.exports = { SemanticSession, AgentState };
