const PtyProcess = require('./pty-process');
const screenParser = require('./screen-parser');

class ClaudeAgent extends PtyProcess {
  constructor(options = {}) {
    super(options);
    this.claudeSessionId = options.claudeSessionId || null;
    this._spawnUsedResume = false;
  }

  spawnWithResume(sessionId) {
    this.claudeSessionId = sessionId;
    this._spawnUsedResume = true;
    const args = sessionId ? ['--resume', sessionId] : [];
    this.spawn(args);
  }

  spawnFresh() {
    this._spawnUsedResume = false;
    this.spawn();
  }

  get spawnUsedResume() {
    return this._spawnUsedResume;
  }
}

module.exports = {
  ClaudeAgent,
  PtyProcess,
  screenParser,
  COLS: screenParser.COLS,
  ROWS: screenParser.ROWS,
};
