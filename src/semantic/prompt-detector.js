const { getScreenLines } = require('../cli-agent/screen-parser');

function cleanInteractiveLine(line) {
  return String(line || '')
    .replace(/[╭╰╮╯│─━╌┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Chrome lines that are never selectable option labels. (Note: status-bar words
// like "Opus"/"claude-" are intentionally NOT here — they never match the
// numbered/marker option shapes, yet ARE valid labels in a model-select menu.)
const OPTION_NOISE = /^(Submit|Skills|Using|Context Usage|esc to|press |enter to)/i;

// Navigation/footer hints the CLI prints under a menu. These are not options.
const MENU_HINT = /(?:[↑↓←→].*(?:select|confirm|submit))|(?:\bto (?:select|confirm|submit|cycle)\b)|esc to|shift\+tab|bypass permissions/i;

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

// A line that could be an unmarked sibling option (radio menus render only the
// selected row with a cursor; the rest are plain indented labels). Conservative:
// excludes noise, the prompt question itself, and over-long prose.
function looksLikeOption(line) {
  const t = cleanInteractiveLine(line);
  if (!t) return false;
  if (OPTION_NOISE.test(t)) return false;
  if (MENU_HINT.test(t)) return false;          // footer/nav hint, not an option
  if (t.length > 80) return false;
  if (/[？?：:]\s*$/.test(t)) return false;   // prompt/question line, not an option
  return true;
}

// Strip a leading selection marker / number to get the bare label of a row that
// is already known to belong to the menu.
function rowLabel(line) {
  const viaOption = optionText(line);
  if (viaOption) return viaOption;
  return cleanInteractiveLine(line).replace(/^[❯>→○●◉◯☐☑☒✔✓]\s*/, '').trim();
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

  // Collect the trailing menu block. The real menu is the last run of option
  // lines, so anchor on it and walk outward. Two row shapes coexist:
  //   - numbered / marker rows  (`1. Foo`, `❯ 2. Bar`, `○ Baz`)
  //   - radio rows where ONLY the selected line carries the ❯ cursor and the
  //     siblings are plain indented labels (`❯ Default` / `  Opus` / `  Sonnet`).
  // The old code only kept rows matching optionText(), so unmarked siblings were
  // dropped and single-cursor menus collapsed to one option. Anchor on either a
  // numbered run or the cursor line, then expand to adjacent sibling labels.
  let lastIdx = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (optionText(tail[i]) !== null) { lastIdx = i; break; }
    if (isCursorLine(tail[i]) && rowLabel(tail[i])) { lastIdx = i; break; }
  }

  if (lastIdx >= 0) {
    // Walk up from the anchor collecting contiguous option-ish lines.
    let start = lastIdx;
    for (let i = lastIdx; i >= 0; i--) {
      if (optionText(tail[i]) !== null || (isCursorLine(tail[i]) && rowLabel(tail[i])) || looksLikeOption(tail[i])) {
        start = i;
      } else {
        break;
      }
    }
    // Walk down from the anchor for trailing siblings (radio rows below cursor).
    let end = lastIdx;
    for (let i = lastIdx + 1; i < tail.length; i++) {
      if (optionText(tail[i]) !== null || (isCursorLine(tail[i]) && rowLabel(tail[i])) || looksLikeOption(tail[i])) {
        end = i;
      } else {
        break;
      }
    }
    for (let i = start; i <= end; i++) {
      const label = rowLabel(tail[i]);
      if (!label) continue;
      state.options.push(label);
      if (isCursorLine(tail[i])) state.selected = state.options.length - 1;
    }
  }

  // The prompt is the question line near the menu. Prefer a line ending in a
  // question/colon (any language), then fall back to the keyword hints. Skip
  // option rows, the Submit footer, and chrome lines.
  const isChrome = (line) =>
    /^←/.test(line) ||
    /^[❯>→]?\s*\d+[.)、]/.test(line) ||
    /\bSubmit\b/i.test(line) ||
    /^(Skills|Using|Context Usage|Opus|claude-)/i.test(line) ||
    state.options.includes(rowLabel(line));

  const questionLines = tail.filter(line => !isChrome(line) && /[？?：:]\s*$/.test(line));
  const keywordLines = tail.filter(line => !isChrome(line) &&
    /用什么|选择|输入|是否|确认|允许|可见性|仓库名|请问|要不要/.test(line));
  state.prompt = questionLines[questionLines.length - 1] ||
    keywordLines[keywordLines.length - 1] || '';

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
    parts.push('回复 “确认/yes” 允许，“取消/no” 拒绝');
  } else if (state.type === 'confirm') {
    parts.push('回复 “确认/yes” 继续，“取消/no” 取消');
  } else if (state.type === 'select' && state.options.length) {
    state.options.forEach((option, index) => {
      const marker = state.selected === index ? ' ❮ 当前' : '';
      parts.push(`${index + 1}. ${option}${marker}`);
    });
    parts.push('—— 回复序号选择（例: 1），或直接回复要输入的内容');
  } else if (state.type === 'text_input') {
    parts.push('—— 请直接回复要输入的内容');
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
