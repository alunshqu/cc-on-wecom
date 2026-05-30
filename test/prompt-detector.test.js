#!/usr/bin/env node
// Tests for interactive-prompt detection and parsing. No framework — run with:
//   node test/prompt-detector.test.js
// Builds realistic Claude TUI screens, writes them into a real headless
// terminal, and asserts detectScreenType + parseInteractiveState behaviour,
// including that Claude's PROSE about trust/permissions/menus is NOT misread.

const { createTerminal, getScreenText, detectScreenType } = require('../src/cli-agent/screen-parser');
const { parseInteractiveState, formatInteractivePrompt } = require('../src/semantic/prompt-detector');

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; }
  else { failed++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

// Render text into a fresh terminal and return the vt + serialized screen.
// xterm/headless parses writes asynchronously, so flush via the write callback.
function screen(text) {
  const vt = createTerminal();
  return new Promise((resolve) => {
    vt.write(text.replace(/\n/g, '\r\n'), () => {
      resolve({ vt, text: getScreenText(vt) });
    });
  });
}

// ---- Fixtures (approximate the real CLI layout) ----

const FOOTER = '\n? for shortcuts                                 bypass permissions · shift+tab to cycle';

const IDLE = `⏺ Done.\n\n╭──────────────────────────────────────────╮\n│ ❯                                          │\n╰──────────────────────────────────────────╯${FOOTER}`;

const PROCESSING = `✻ Thinking… (3s · esc to interrupt)\n\n⏺ Working on it`;

const NUMBERED_MENU = `Which visibility should the repo have?\n\n❯ 1. Public\n  2. Private\n  3. Internal\n\n  ↑/↓ to select · Enter to confirm`;

// Radio menu: ONLY the selected row carries the cursor; siblings are unmarked.
const RADIO_MENU = `Select a model:\n\n❯ Default (recommended)\n  Opus\n  Sonnet\n\n  Enter to confirm`;

const TEXT_INPUT = `What should the repo be named?\n\n╭──────────────────────────────────────────╮\n│ ❯                                          │\n╰──────────────────────────────────────────╯`;

const PERMISSION = `Claude wants to run: rm -rf build\n\nDo you want to allow this?\n❯ 1. Yes, allow once\n  2. No, deny\n\n  Enter to confirm`;

// PROSE false positives — Claude DISCUSSING these things, not a live prompt.
const PROSE_TRUST = `⏺ When you first open a folder, Claude shows "Do you trust the files in this folder?" and you pick "Yes, I trust" or "No, exit". I handle that automatically.\n\n╭────────────────────────╮\n│ ❯                       │\n╰────────────────────────╯${FOOTER}`;

const PROSE_PERMISSION = `⏺ The hook can return Allow or Deny to gate a tool call. Here's how Yes/No maps.\n\n╭────────────────────────╮\n│ ❯                       │\n╰────────────────────────╯${FOOTER}`;

const PROSE_NUMBERED = `⏺ Here are the steps:\n\n1. Read the config file\n2. Parse the options\n3. Write the result\n\nDone.\n\n╭────────────────────────╮\n│ ❯                       │\n╰────────────────────────╯${FOOTER}`;

// REAL trust prompt at startup.
const TRUST = `╭─────────────────────────────────────────────╮\n│ Do you trust the files in this folder?        │\n│                                               │\n│ ❯ 1. Yes, I trust the files                   │\n│   2. No, exit                                 │\n╰─────────────────────────────────────────────╯`;

// ---- detectScreenType ----
(async () => {
const S = {};
for (const [k, v] of Object.entries({ IDLE, PROCESSING, NUMBERED_MENU, RADIO_MENU, TEXT_INPUT, PERMISSION, PROSE_TRUST, PROSE_PERMISSION, PROSE_NUMBERED, TRUST })) {
  S[k] = await screen(v);
}

console.log('detectScreenType:');
check('idle', detectScreenType(S.IDLE.text) === 'idle', detectScreenType(S.IDLE.text));
check('processing', detectScreenType(S.PROCESSING.text) === 'processing', detectScreenType(S.PROCESSING.text));
check('numbered menu → interactive', detectScreenType(S.NUMBERED_MENU.text) === 'interactive_prompt', detectScreenType(S.NUMBERED_MENU.text));
check('radio menu → interactive', detectScreenType(S.RADIO_MENU.text) === 'interactive_prompt', detectScreenType(S.RADIO_MENU.text));
check('text input → interactive', detectScreenType(S.TEXT_INPUT.text) === 'interactive_prompt', detectScreenType(S.TEXT_INPUT.text));
check('permission menu → interactive', detectScreenType(S.PERMISSION.text) === 'interactive_prompt', detectScreenType(S.PERMISSION.text));
check('real trust prompt', detectScreenType(S.TRUST.text) === 'trust_prompt', detectScreenType(S.TRUST.text));

console.log('detectScreenType (prose must NOT be interactive/trust):');
check('prose trust → not trust_prompt', detectScreenType(S.PROSE_TRUST.text) !== 'trust_prompt', detectScreenType(S.PROSE_TRUST.text));
check('prose trust → idle', detectScreenType(S.PROSE_TRUST.text) === 'idle', detectScreenType(S.PROSE_TRUST.text));
check('prose permission → idle', detectScreenType(S.PROSE_PERMISSION.text) === 'idle', detectScreenType(S.PROSE_PERMISSION.text));
check('prose numbered list → idle', detectScreenType(S.PROSE_NUMBERED.text) === 'idle', detectScreenType(S.PROSE_NUMBERED.text));

// ---- parseInteractiveState ----
console.log('parseInteractiveState:');
const numbered = parseInteractiveState(S.NUMBERED_MENU.vt);
check('numbered: type select', numbered.type === 'select', numbered.type);
check('numbered: 3 options', numbered.options.length === 3, JSON.stringify(numbered.options));
check('numbered: selected=0', numbered.selected === 0, String(numbered.selected));

const radio = parseInteractiveState(S.RADIO_MENU.vt);
check('radio: type select', radio.type === 'select', radio.type);
check('radio: 3 options (siblings kept)', radio.options.length === 3, JSON.stringify(radio.options));
check('radio: selected=0', radio.selected === 0, String(radio.selected));
check('radio: label has no marker', radio.options[0] === 'Default (recommended)', JSON.stringify(radio.options[0]));

const textInput = parseInteractiveState(S.TEXT_INPUT.vt);
check('text input: type text_input', textInput.type === 'text_input', textInput.type);
check('text input: no options', textInput.options.length === 0, JSON.stringify(textInput.options));

const perm = parseInteractiveState(S.PERMISSION.vt);
check('permission: type permission', perm.type === 'permission', perm.type);

// ---- formatInteractivePrompt ----
console.log('formatInteractivePrompt:');
const fmt = formatInteractivePrompt(numbered, null);
check('format: lists numbered options', /1\. Public/.test(fmt) && /2\. Private/.test(fmt), fmt);
check('format: marks current', /当前/.test(fmt), fmt);
check('format: select hint', /回复序号/.test(fmt), fmt);
const fmtText = formatInteractivePrompt(textInput, null);
check('format: text_input hint', /请直接回复/.test(fmtText), fmtText);

// ---- summary ----
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
})();
