const { AgentState } = require('./event-types');
const { getScreenText, detectScreenType } = require('../cli-agent/screen-parser');

class StateMachine {
  constructor(session, { log, onReady, onFinish, onInteractive, onProcessing }) {
    this.session = session;
    this.log = log;
    this.onReady = onReady;
    this.onFinish = onFinish;
    this.onInteractive = onInteractive;
    this.onProcessing = onProcessing;

    this._doneTimer = null;
    this._sentMsgTimeout = null;
    this._sentMsgAbsoluteTimeout = null;
    this._processingWatchdog = null;
    this._stabilitySnapshot = null;
  }

  tick() {
    const text = getScreenText(this.session.agent.vt);
    const screenType = detectScreenType(text);
    this.handleState(screenType);
  }

  handleState(screenType) {
    const s = this.session;

    if (screenType === 'trust_prompt' && !s.sentTrustEnter && s.phase === AgentState.INIT) {
      s.sentTrustEnter = true;
      s.phase = AgentState.WAITING_TRUST;
      this.log('Trust prompt -> sending Enter in 500ms');
      setTimeout(() => { if (s.agent.alive) s.agent.sendEnter(); }, 500);
      return;
    }

    if (s.phase === AgentState.WAITING_TRUST && screenType === 'idle') {
      this.onReady('Claude ready!');
      return;
    }

    if (s.phase === AgentState.INIT && screenType === 'idle') {
      this.onReady('Claude ready (no trust prompt)!');
      return;
    }

    if (s.phase === AgentState.SENT_MSG) {
      this._handleSentMsg(screenType);
      return;
    }

    if (s.phase === AgentState.PROCESSING) {
      this._handleProcessing(screenType);
      return;
    }
  }

  _handleSentMsg(screenType) {
    const s = this.session;
    if (screenType === 'processing') {
      this.onProcessing();
    } else if (screenType === 'interactive_prompt') {
      this.onInteractive();
    } else if (screenType === 'idle') {
      this._scheduleStabilityCheck('sent_msg_idle');
    } else if (screenType === 'done') {
      this.onProcessing();
      this._scheduleStabilityCheck('fast_done');
    }

    if (!this._sentMsgTimeout) {
      this._sentMsgTimeout = setTimeout(() => {
        this._sentMsgTimeout = null;
        if (s.phase !== AgentState.SENT_MSG) return;
        const currentType = detectScreenType(getScreenText(s.agent.vt));
        this.log(`sent_msg failsafe: screenType=${currentType}`);
        if (currentType === 'idle') {
          this.onFinish('sent_msg_failsafe');
        } else if (currentType === 'processing') {
          this.onProcessing();
        } else if (currentType === 'interactive_prompt') {
          this.onInteractive();
        }
      }, 20000);
    }
  }

  _handleProcessing(screenType) {
    const s = this.session;
    if (screenType === 'processing') {
      s.agent.lastActivityAt = Date.now();
      if (this._doneTimer) { clearTimeout(this._doneTimer); this._doneTimer = null; }
    } else if (screenType === 'interactive_prompt') {
      this.onInteractive();
    } else if (screenType === 'idle' || screenType === 'done' || screenType === 'unknown') {
      this._scheduleStabilityCheck(`processing_to_${screenType}`);
    }

    if (!this._processingWatchdog) {
      this._processingWatchdog = setInterval(() => {
        if (s.phase !== AgentState.PROCESSING) {
          clearInterval(this._processingWatchdog);
          this._processingWatchdog = null;
          return;
        }
        const inactiveMs = Date.now() - s.agent.lastActivityAt;
        if (inactiveMs >= 10000) {
          const currentType = detectScreenType(getScreenText(s.agent.vt));
          this.log(`Processing watchdog: inactive ${Math.round(inactiveMs / 1000)}s, screenType=${currentType}`);
          if (currentType === 'idle' || currentType === 'done' || currentType === 'unknown') {
            clearInterval(this._processingWatchdog);
            this._processingWatchdog = null;
            this.onFinish('watchdog_inactive');
          } else if (currentType === 'interactive_prompt') {
            this.onInteractive();
          }
        }
      }, 5000);
    }
  }

  _scheduleStabilityCheck(reason) {
    if (this._doneTimer) return;
    const snapshot = getScreenText(this.session.agent.vt);
    this._stabilitySnapshot = snapshot;

    this._doneTimer = setTimeout(() => {
      this._doneTimer = null;
      const s = this.session;
      if (s.phase !== AgentState.PROCESSING && s.phase !== AgentState.SENT_MSG) return;

      const currentScreen = getScreenText(s.agent.vt);
      const currentType = detectScreenType(currentScreen);

      if (currentScreen !== this._stabilitySnapshot) {
        if (currentType === 'processing') {
          s.agent.lastActivityAt = Date.now();
          return;
        }
        this._scheduleStabilityCheck(reason + '_retry');
        return;
      }

      if (currentType === 'interactive_prompt') {
        this.onInteractive();
      } else if (currentType === 'idle' || currentType === 'done' || currentType === 'unknown') {
        this.onFinish(reason);
      } else if (currentType === 'processing') {
        s.agent.lastActivityAt = Date.now();
      }
    }, 2000);
  }

  clearTimers() {
    if (this._doneTimer) { clearTimeout(this._doneTimer); this._doneTimer = null; }
    if (this._sentMsgTimeout) { clearTimeout(this._sentMsgTimeout); this._sentMsgTimeout = null; }
    if (this._sentMsgAbsoluteTimeout) { clearTimeout(this._sentMsgAbsoluteTimeout); this._sentMsgAbsoluteTimeout = null; }
    if (this._processingWatchdog) { clearInterval(this._processingWatchdog); this._processingWatchdog = null; }
  }
}

module.exports = StateMachine;
