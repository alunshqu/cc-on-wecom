const os = require('os');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

function homedir() {
  return os.homedir();
}

function tmpdir() {
  return os.tmpdir();
}

function defaultClaudePath() {
  if (IS_WIN) return 'claude.cmd';
  return '/usr/local/bin/claude';
}

function shellEnv() {
  if (IS_WIN) return { ...process.env };
  return { ...process.env, TERM: 'xterm-256color' };
}

module.exports = { IS_WIN, IS_MAC, IS_LINUX, homedir, tmpdir, defaultClaudePath, shellEnv };
