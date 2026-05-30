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

// True only for the idle main input area: an empty `❯ ` (or `>`) prompt line
// accompanied by the persistent footer hints. This must NOT be treated as an
// interactive menu — it's where the user types a fresh message.
function isIdleInputArea(tail) {
  return /(^|\n)\s*[❯>]\s*$/m.test(tail) && (
    tail.includes('bypass permissions') ||
    tail.includes('shift+tab') ||
    /type your message|Try "/i.test(tail)
  );
}

// Structural detection of an interactive prompt (selection menu, confirm, or a
// text-input step inside a prompt) — no keyword whitelist. The reliable signals
// are a cursor (❯) pointing at a real option, or the footer the CLI renders for
// arrow-key menus. A bare numbered list is NOT enough: Claude's prose answers
// often end in "1. … 2. …", and those must not be mistaken for a menu. The idle
// main input box is explicitly excluded.
function isInteractivePrompt(tail) {
  if (isIdleInputArea(tail)) return false;

  // A cursor pointing at a real option (numbered, or a non-empty label).
  const cursorOnOption = /(^|\n)\s*❯\s*\d+[.)、]\s+\S/m.test(tail) ||
    /(^|\n)\s*❯\s+\S/m.test(tail);

  // The footer the CLI prints under arrow-key menus (kept conservative so prose
  // mentioning "Submit"/"select" doesn't trip it).
  const menuFooter = /←.*Submit.*→/.test(tail) ||
    /\b✔\s*Submit\b/.test(tail) ||
    /\bEnter\s+to\s+(confirm|submit|select)\b/i.test(tail) ||
    /[↑↓].*\bto select\b/i.test(tail) ||
    (/\besc to\b/i.test(tail) && !/esc to interrupt/i.test(tail));

  if (cursorOnOption || menuFooter) return true;

  // Text-input step (e.g. "Repo name?" then an empty box). It renders as a bare
  // `❯ ` line (often inside box borders: `│ ❯   │`) with NO menu options and NO
  // idle footer, preceded by a prompt line ending in a question/colon. Requires
  // that preceding prompt so we don't catch every transient empty box.
  const stripBox = (l) => l.replace(/[│┃|╭╮╰╯─━┌┐└┘┄┈]/g, ' ').trim();
  const tLines = tail.split('\n').map(stripBox).filter(Boolean);
  const lastEmptyBox = tLines.length > 0 && /^[❯>]\s*$/.test(tLines[tLines.length - 1]);
  if (lastEmptyBox) {
    const recent = tLines.slice(-6, -1);
    if (recent.some(l => /[?？:：]\s*$/.test(l))) return true;
  }
  return false;
}

function detectScreenType(text) {
  const lines = text.split('\n');
  const nonEmptyLines = lines.filter(l => l.trim());
  const tail = nonEmptyLines.slice(-15).join('\n');

  // Trust prompt: require the structural signature (the question plus BOTH
  // choice lines), not a loose substring — otherwise Claude's own prose about
  // "trust this folder" or quoting the choices trips it mid-conversation.
  const trustQuestion = /Do you trust the files in this folder\?/i.test(text) ||
    /trust the files in this folder/i.test(text);
  const trustChoices = /Yes,?\s*I trust/i.test(text) && /No,?\s*exit/i.test(text);
  if (trustQuestion && trustChoices) {
    return 'trust_prompt';
  }

  if (isInteractivePrompt(tail)) {
    return 'interactive_prompt';
  }

  // Permission prompt: require the actual y/n affordance on the tail (a live
  // prompt), not loose "Allow/Deny" mentions anywhere on screen — otherwise
  // Claude's prose about permissions trips it. A real interactive permission
  // menu is already caught by isInteractivePrompt above.
  if (/\((?:y\/n|Y\/N)\)\s*$/m.test(tail) && /\b(Allow|Deny|permission)\b/i.test(tail)) {
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
