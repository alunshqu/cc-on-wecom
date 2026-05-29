const { getScreenLines } = require('../cli-agent/screen-parser');

function cleanInteractiveLine(line) {
  return String(line || '')
    .replace(/[╭╰╮╯│─━╌┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const OPTION_NOISE = /^(Submit|Skills|Using|Context Usage|Opus|claude-|esc to|press |enter to)/i;

// Returns the option label for a real menu line, or null if the line is not a
// selectable option. Only numbered lines (`1.` `2.`) and lines led by a genuine
// selection marker (cursor / radio / checkbox) count — markdown bullets (`-` `*`)
// in Claude's prose are intentionally excluded so they aren't mistaken for options.
function optionText(line) {
  let m = line.match(/^[❯>→○●◉◯☐☑☒✔✓\s]*(\d+)[.)、]\s+(.+)$/);
  if (m) {
    const t = m[2].trim();
    return OPTION_NOISE.test(t) ? null : t;
  }
  m = line.match(/^[❯>→○●◉◯☐☑☒✔✓]\s+([^\s].+)$/);
  if (m) {
    const t = m[1].trim();
    if (OPTION_NOISE.test(t) || t.length > 80 || /[？?]$/.test(t)) return null;
    return t;
  }
  return null;
}

function isCursorLine(line) {
  return /^[❯>→]/.test(line);
}

function parseInteractiveState(vt) {
  const rawLines = getScreenLines(vt).filter(l => l.trim());
  const lines = rawLines.map(cleanInteractiveLine).filter(Boolean);
  const tail = lines.slice(-30);
  const tailText = tail.join('\n');
  const state = {
    type: 'unknown',
    prompt: '',
    options: [],
    selected: null,
    submitAvailable: /\bSubmit\b/i.test(tailText),
    rawTail: tail,
  };

  if (/\b(Allow|Deny|allow once|allow always|permission|permissions)\b/i.test(tailText) && /\b(Yes|No|Allow|Deny|y\/n)\b/i.test(tailText)) {
    state.type = 'permission';
  } else if (/\b(Yes|No|Confirm|Cancel|确认|取消|继续|拒绝)\b/i.test(tailText) && /[？?]$/.test(tailText.replace(/\n/g, ' '))) {
    state.type = 'confirm';
  }

  // Collect only the contiguous trailing block of menu options. Scanning the
  // whole tail caused prose bullet/numbered lists in Claude's answer to be
  // harvested as fake options. The real menu is always the last run of option
  // lines, so walk from the bottom up and stop at the first non-option line.
  const optionLines = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const label = optionText(tail[i]);
    if (label !== null) {
      optionLines.unshift({ label, cursor: isCursorLine(tail[i]) });
    } else if (optionLines.length) {
      break;
    }
  }
  optionLines.forEach(({ label, cursor }) => {
    state.options.push(label);
    if (cursor) state.selected = state.options.length - 1;
  });

  const promptCandidates = tail.filter(line =>
    !/^←/.test(line) &&
    !/^❯\s*\d/.test(line) &&
    !/^\d+[.)、]/.test(line) &&
    !/\bSubmit\b/i.test(line) &&
    !/^(Skills|Using|Context Usage|Opus|claude-)/i.test(line) &&
    (/[？?]$/.test(line) || /用什么|选择|输入|是否|确认|允许|可见性|仓库名/.test(line))
  );
  state.prompt = promptCandidates[promptCandidates.length - 1] || '';

  if (state.type === 'unknown') {
    if (state.options.length > 0) state.type = 'select';
    else if (state.prompt || state.submitAvailable || /❯\s*$/.test(tailText)) state.type = 'text_input';
  }

  state.options = [...new Set(state.options)].slice(0, 8);
  return state;
}

function formatInteractivePrompt(state, response) {
  const parts = [];
  if (response) parts.push(response);

  if (state.prompt && (!response || !response.includes(state.prompt))) {
    parts.push(`**${state.prompt}**`);
  }

  if (state.type === 'permission') {
    parts.push('⚠️ 需要权限确认');
  } else if (state.type === 'confirm') {
    parts.push('需要确认');
  } else if (state.type === 'select' && state.options.length) {
    state.options.forEach((option, index) => {
      const marker = state.selected === index ? ' ✓' : '';
      parts.push(`${index + 1}. ${option}${marker}`);
    });
  } else if (state.type === 'text_input') {
    parts.push('请输入内容：');
  }

  return parts.filter(Boolean).join('\n');
}

function normalizeInteractiveInput(text) {
  const trimmed = String(text || '').trim().toLowerCase();
  if (/^(确认|提交|确定|ok|yes|y)$/.test(trimmed)) return '\r';
  if (/^(取消|不要|否|no|n)$/.test(trimmed)) return '\x1b';
  return null;
}

module.exports = { parseInteractiveState, formatInteractivePrompt, normalizeInteractiveInput };
