const { Terminal } = require('@xterm/headless');

const COLS = 120;
const ROWS = 200;
const SCROLLBACK = 5000;

function createTerminal() {
  return new Terminal({ cols: COLS, rows: ROWS, scrollback: SCROLLBACK, allowProposedApi: true });
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

function getScreenText(vt) {
  return getViewportLines(vt).join('\n');
}

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

  if (/Allow|Deny|allow once|allow always/i.test(text) && /\(y\/n\)|Yes.*No/i.test(text)) {
    return 'permission_prompt';
  }

  const activeProcessing =
    /(^|\n)\s*[✻●⏺◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\w+ing\b/m.test(tail) ||
    (/esc to interrupt/i.test(tail) && /(^|\n)\s*[✻●⏺◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/m.test(tail));

  if (activeProcessing) {
    return 'processing';
  }

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

  if (/[✻●⏺]\s*\w+ed\s+(in|for)\s+[\d.]+s/.test(tail) || /completed in [\d.]+s/i.test(tail)) {
    return 'done';
  }

  return 'unknown';
}

module.exports = {
  COLS, ROWS, SCROLLBACK,
  createTerminal,
  getScreenLines, getViewportLines, getScreenText,
  detectScreenType,
};
