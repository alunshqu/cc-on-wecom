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

// Structural detection of an interactive prompt (selection menu / confirm).
// The ONLY reliable signal is the arrow-key-menu shape: a cursor (❯) pointing at
// a NUMBERED option, or the menu footer the CLI prints ("Enter to confirm",
// "Esc to cancel", "↑/↓ to select", "← Submit →"). A bare `❯ <text>` is NOT a
// menu — that is the main input box with text typed into it (including the
// transient `❯ /context` we write before pressing Enter), and matching it made
// every normal turn look like a selection. The idle input box is excluded too.
function isInteractivePrompt(tail) {
  if (isIdleInputArea(tail)) return false;

  // A cursor pointing at a NUMBERED option, e.g. "❯ 1. Yes". Requires the digit
  // so the plain input prompt (`❯ something`) can never match.
  const cursorOnNumbered = /(^|\n)\s*❯\s*\d+[.)、]\s+\S/m.test(tail);

  // The footer the CLI prints under arrow-key menus (kept conservative so prose
  // mentioning "Submit"/"select" doesn't trip it).
  const menuFooter = /←.*Submit.*→/.test(tail) ||
    /\b✔\s*Submit\b/.test(tail) ||
    /\bEnter\s+to\s+(confirm|submit|select)\b/i.test(tail) ||
    /\bEsc\s+to\s+cancel\b/i.test(tail) ||
    /[↑↓].*\bto select\b/i.test(tail);

  return cursorOnNumbered || menuFooter;
}

function detectScreenType(text) {
  const lines = text.split('\n');
  const nonEmptyLines = lines.filter(l => l.trim());
  const tail = nonEmptyLines.slice(-15).join('\n');

  // Trust prompt: key on the two distinctive choice lines, which the startup
  // screen always renders as a selectable menu ("❯ 1. Yes, I trust …" /
  // "2. No, exit"). The question wording varies across CLI versions (e.g.
  // "Is this a project you created or one you trust?"), so we do NOT depend on
  // it. Requiring BOTH choice lines plus an option marker keeps Claude's prose
  // from tripping it — bare prose mentioning "trust" won't have the 1./2. menu.
  const trustYes = /\bYes,?\s*I trust\b/i.test(text);
  const trustNo = /\bNo,?\s*exit\b/i.test(text);
  const trustMenuMarker = /(^|\n)\s*(?:❯\s*)?[12][.)、]\s*(?:Yes,?\s*I trust|No,?\s*exit)/im.test(text);
  if (trustYes && trustNo && trustMenuMarker) {
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
