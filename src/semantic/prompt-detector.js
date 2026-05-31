const { getScreenLines } = require('../cli-agent/screen-parser');

function cleanInteractiveLine(line) {
  return String(line || '')
    .replace(/[╭╰╮╯│─━╌┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Like cleanInteractiveLine but PRESERVES internal spacing (only strips box
// borders and trims the ends). Needed to split an option's short label from its
// padded inline description, which collapse-to-single-space would destroy.
function stripBoxKeepSpacing(line) {
  return String(line || '')
    .replace(/[╭╰╮╯│─━╌┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]/g, ' ')
    .replace(/\s+$/, '')
    .replace(/^\s+/, '');
}

// Chrome lines that are never selectable option labels. (Note: status-bar words
// like "Opus"/"claude-" are intentionally NOT here — they never match the
// numbered/marker option shapes, yet ARE valid labels in a model-select menu.)
// "Submit" must be anchored ($) so it only drops the standalone Submit
// affordance, NOT a real option like "Submit answers".
const OPTION_NOISE = /^(Submit\s*$|Skills\b|Using\b|Context Usage\b|esc to|press |enter to)/i;

// Navigation/footer hints the CLI prints under a menu. These are not options.
// The "<key> to <action>" forms are anchored to real footer keys (Enter/Tab/
// Esc/arrows) so a prose question like "Ready to submit your answers?" — which
// contains "to submit" — is NOT mistaken for a footer.
const MENU_HINT = /(?:[↑↓←→].*(?:select|confirm|submit))|(?:\b(?:Enter|Tab|Esc|Space|↑|↓|←|→)\b[^\n]*\bto (?:select|confirm|submit|cycle|navigate)\b)|esc to|shift\+tab|bypass permissions/i;

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

// Parse the trailing numbered menu (`1. foo`, `❯ 2. bar`). Returns the ordered
// option list, the selected index (the numbered row carrying the ❯ cursor), and
// the index range the block spans in `tail`. This is the reliable shape for the
// CLI's selection menus (/model, trust, permission, AskUserQuestion). We collect
// ONLY numbered rows so description/footer prose interleaved in the menu is not
// mistaken for options.
// Checkbox glyphs Claude Code uses for multi-select rows, in checked / unchecked
// forms. The CLI renders checked as [✔] (also tolerate ☑/☒/◉/[x]) and unchecked
// as [ ] (also ☐/◯). Detected per-row so we know which items are toggled on.
const CHECKED_RE = /[☑☒◉]|\[\s*[✔✓xX]\s*\]/;
const UNCHECKED_RE = /[☐◯]|\[\s*\]/;

function parseNumberedMenu(spacedTail) {
  const rows = [];
  for (let i = 0; i < spacedTail.length; i++) {
    const m = spacedTail[i].match(/^[❯>→○●◉◯☐☑☒✔✓\s]*?(\d+)[.)、]\s+(.+)$/);
    if (!m) continue;
    const label = m[2];
    if (OPTION_NOISE.test(label.trim())) continue;
    const full = spacedTail[i];
    const checked = CHECKED_RE.test(full) ? true : (UNCHECKED_RE.test(full) ? false : null);
    rows.push({ i, num: parseInt(m[1], 10), label, cursor: /^[❯>→]/.test(spacedTail[i].trim()), checked });
  }
  if (rows.length < 1) return null;
  // Keep the trailing contiguous run by ascending number (1,2,3…) so a stray
  // numbered line earlier in prose doesn't merge into the real menu.
  let end = rows.length - 1;
  let start = end;
  for (let k = end - 1; k >= 0; k--) {
    if (rows[k].num === rows[k + 1].num - 1) start = k; else break;
  }
  const block = rows.slice(start, end + 1);
  let selected = block.findIndex(r => r.cursor);
  const shorts = block.map(r => (r.label.split(/\s{2,}/)[0] || '').replace(/\s*[✔✓☑]\s*$/, '').trim());
  // A menu is multi-select if any row carries a checkbox glyph.
  const hasCheckboxes = block.some(r => r.checked !== null);
  return {
    options: block.map(r => cleanOptionLabel(r.label, shorts)),
    checked: block.map(r => r.checked === true),
    rowCursor: block.map(r => r.cursor),
    hasCheckboxes,
    selected: selected === -1 ? null : selected,
    firstLine: block[0].i,
  };
}

// (Submit/Next/Type/Chat affordance rows are classified inline in
// parseInteractiveState; no shared regex needed here.)

// The raw text of the line the menu cursor (❯) is currently on, with box borders
// stripped. Used to drive multi-select submit: the "Submit" row is not numbered,
// so we navigate by arrowing until the cursor sits on a line matching /submit/i.
function cursorLineText(vt) {
  const lines = getScreenLines(vt)
    .map(l => l.replace(/[╭╰╮╯│─━╌┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]/g, ' ').trimEnd())
    .filter(l => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*[❯>→]/.test(lines[i])) {
      return lines[i].replace(/^\s*[❯>→]\s*/, '').trim();
    }
  }
  return '';
}

// Build a clean, distinct label from a menu row. The CLI pads a short label and
// its description apart with 2+ spaces ("Default (recommended)   Use the default
// model …"). Prefer the short label, but if it would collide with a sibling
// (e.g. three "claude-opus-4-8" rows), append the description to disambiguate.
function cleanOptionLabel(label, siblingsShort) {
  // Strip a leading checkbox/radio glyph that sits after the number ("1. ☐ Foo",
  // "2. [x] Bar", "3. [✔] Baz") so the label is just the text.
  const stripped = label.replace(/^\s*(?:[☐☑☒◉◯○●]|\[\s*[ xX✔✓]?\s*\])\s*/, '');
  const parts = stripped.split(/\s{2,}/).map(p => p.trim()).filter(Boolean);
  let short = (parts[0] || stripped.trim()).replace(/\s*[✔✓☑]\s*$/, '').trim();
  const desc = parts.slice(1).join(' — ').replace(/\s*[✔✓☑]\s*/g, '').trim();
  if (desc && siblingsShort && siblingsShort.filter(s => s === short).length > 1) {
    return `${short} — ${desc}`.slice(0, 90);
  }
  return (short || label.trim()).slice(0, 90);
}

// Multi-step prompts show a stage bar at the top, navigated with ←/→:
//   "← ☒ 主题 ☒ 字号 ☐ 快捷键 ✔ Submit →"
// Each stage has a glyph (☒/☑ done, ☐ pending, ✔ on Submit) and a label; the
// last stage is "Submit". Returns { stages:[{glyph,label}], submitIndex } or null.
// We use this to commit a multi-select: press → until on Submit, then Enter.
function parseStageBar(tailLines) {
  for (const raw of tailLines) {
    if (!/[←→]/.test(raw)) continue;
    if (!/(Submit|提交)/i.test(raw)) continue;
    const inner = raw.replace(/[←→]/g, ' ').trim();
    const stages = [];
    const re = /([☒☑☐✔✓])\s+([^\s☒☑☐✔✓]+(?:\s+[^\s☒☑☐✔✓]+)*?)(?=\s+[☒☑☐✔✓]|\s*$)/g;
    let m;
    while ((m = re.exec(inner)) !== null) {
      stages.push({ glyph: m[1], label: m[2].trim() });
    }
    if (stages.length < 2) continue;
    const submitIndex = stages.findIndex(s => /^(Submit|提交)$/i.test(s.label));
    if (submitIndex === -1) continue;
    return { stages, submitIndex };
  }
  return null;
}

function parseInteractiveState(vt) {
  const rawLines = getScreenLines(vt).filter(l => l.trim());
  const lines = rawLines.map(cleanInteractiveLine).filter(Boolean);
  // Parallel array with spacing preserved, kept index-aligned with `lines` by
  // applying the SAME keep-test (non-empty after collapse) to the same source.
  const spaced = rawLines
    .filter(l => cleanInteractiveLine(l))
    .map(stripBoxKeepSpacing);
  const tail = lines.slice(-30);
  const spacedTail = spaced.slice(-30);
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

  // Prefer the numbered menu — the reliable, unambiguous shape. Only fall back
  // to the cursor/sibling heuristic when there are no numbered rows (rare radio
  // menus that render labels without numbers).
  const numbered = parseNumberedMenu(spacedTail);
  let menuFirstLine = -1;
  if (numbered) {
    // AskUserQuestion menus end with special rows. Classify each row:
    //   - "Submit" / "Next"        → commit action; not a user choice, filtered
    //                                 out but remembered as the submit row.
    //   - "Type something[.]"      → free-text entry; shown as a choice (the user
    //                                 can pick it, or just reply free text).
    //   - "Chat about this"        → leave the menu and chat; shown as a choice.
    //   - everything else          → a real choice.
    // Navigation uses FULL block indices, so we map displayed numbers back.
    const full = numbered.options;
    let submitIndex = -1;
    const keep = [];
    const kinds = [];                          // role of each displayed option
    full.forEach((label, i) => {
      const t = label.trim();
      if (/^(Submit|Next)$/i.test(t)) { if (submitIndex === -1) submitIndex = i; return; }
      keep.push(i);
      if (/^Type something\.?$/i.test(t)) kinds.push('type');
      else if (/^Chat about this$/i.test(t)) kinds.push('chat');
      else kinds.push('choice');
    });
    state.options = keep.map((i, di) => {
      // Friendlier labels for the two special rows.
      if (kinds[di] === 'type') return '✍️ 自己输入';
      if (kinds[di] === 'chat') return '💬 就这个问题聊聊';
      return full[i];
    });
    state.checked = keep.map(i => numbered.checked[i]);
    state.optionKinds = kinds;                 // 'choice' | 'type' | 'chat'
    state._fullToReal = keep;                  // displayed idx -> full row idx
    state._submitRow = submitIndex;            // full row idx of "Submit"/"Next", or -1
    state._fullChecked = numbered.checked;     // full-coords checkbox state
    state.selected = numbered.selected != null ? keep.indexOf(numbered.selected) : null;
    if (state.selected === -1) state.selected = null;
    menuFirstLine = numbered.firstLine;
    const multiHint = /\bspace\b/i.test(tailText) && /\b(select|toggle|多选|选择)\b/i.test(tailText);
    if (numbered.hasCheckboxes || multiHint) state.type = 'multi_select';
  } else {
    menuFirstLine = collectCursorMenu(tail, state);
  }

  // The prompt is the header just above the menu block. Walk up over the
  // contiguous non-chrome header lines. If any ends in a question/colon, prefer
  // the one CLOSEST to the menu (e.g. "Ready to submit your answers?" on a review
  // screen, sitting just above the options, below unrelated prose). Otherwise
  // take the topmost line (a title with a wrapped description below it).
  if (menuFirstLine > 0) {
    let topmost = '';
    let closestQuestion = '';
    for (let i = menuFirstLine - 1; i >= 0 && i >= menuFirstLine - 6; i--) {
      const line = tail[i];
      if (!line) continue;
      if (isMenuChrome(line)) break;       // hit chrome → header block ended
      if (!closestQuestion && /[？?：:]\s*$/.test(line)) closestQuestion = line;
      topmost = line;                      // keep climbing; topmost wins as fallback
    }
    state.prompt = closestQuestion || topmost || state.prompt;
  }
  if (!state.prompt) {
    const questionLines = tail.filter(line => !isMenuChrome(line) && /[？?：:]\s*$/.test(line));
    const keywordLines = tail.filter(line => !isMenuChrome(line) &&
      /用什么|选择|输入|是否|确认|允许|可见性|仓库名|请问|要不要/.test(line));
    state.prompt = questionLines[questionLines.length - 1] ||
      keywordLines[keywordLines.length - 1] || '';
  }

  if (state.type === 'unknown') {
    if (state.options.length > 0) state.type = 'select';
    else if (state.prompt || state.submitAvailable || /❯\s*$/.test(tailText)) state.type = 'text_input';
  }

  // Multi-step stage bar (← stage1 stage2 … Submit →). Expose it plus the
  // current stage index (the stage whose question is currently shown — matched
  // by label appearing in the prompt) so a multi-select can press → to Submit.
  const bar = parseStageBar(tail);
  if (bar) {
    state.stageBar = bar.stages;
    state.submitStageIndex = bar.submitIndex;
    let cur = -1;
    for (let i = 0; i < bar.stages.length; i++) {
      const lbl = bar.stages[i].label;
      if (/^(Submit|提交)$/i.test(lbl)) continue;
      if (state.prompt && state.prompt.includes(lbl)) { cur = i; break; }
    }
    // Fallback: the active stage is the last non-done one (☐) before Submit.
    if (cur === -1) cur = bar.stages.findIndex(s => s.glyph === '☐');
    state.currentStageIndex = cur;
  }

  // Do NOT dedup: numbered menus are positional, and distinct rows may share a
  // short label (disambiguated above). Just cap the count.
  state.options = state.options.slice(0, 12);
  return state;
}

// Chrome lines that are not the prompt question: option rows, footers, the
// input echo, status glyphs, the banner/welcome art, and known noise.
function isMenuChrome(line) {
  return /^←/.test(line) ||
    /^[❯>→]?\s*\d+[.)、]/.test(line) ||
    /^[❯>]/.test(line) ||                                // the input-echo / cursor line
    /[←→].*\bSubmit\b.*[←→]|✔\s*Submit/i.test(line) ||  // the stage bar / Submit affordance (not any "submit" in prose)
    MENU_HINT.test(line) ||
    /^[●○]/.test(line) ||
    /[▛▜▝▘▗▖█]/.test(line) ||                          // welcome/banner ASCII art
    /Claude Code v\d|API Usage Billing/i.test(line) ||  // banner text
    /^[A-Za-z]:[\\/]/.test(line) ||                      // a cwd path line
    /^(Skills|Using|Context Usage|Opus|claude-|esc to|Enter to|press )/i.test(line);
}

// Fallback for menus that render labels WITHOUT numbers (radio rows where only
// the selected line has a ❯ cursor and siblings are plain indented labels).
// Returns the first line index of the collected block, or -1.
function collectCursorMenu(tail, state) {
  let cursorIdx = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (isCursorLine(tail[i]) && rowLabel(tail[i])) { cursorIdx = i; break; }
  }
  if (cursorIdx === -1) return -1;
  let start = cursorIdx, end = cursorIdx;
  for (let i = cursorIdx - 1; i >= 0; i--) {
    if (looksLikeOption(tail[i]) || (isCursorLine(tail[i]) && rowLabel(tail[i]))) start = i; else break;
  }
  for (let i = cursorIdx + 1; i < tail.length; i++) {
    if (looksLikeOption(tail[i]) || (isCursorLine(tail[i]) && rowLabel(tail[i]))) end = i; else break;
  }
  for (let i = start; i <= end; i++) {
    const label = rowLabel(tail[i]);
    if (!label) continue;
    state.options.push(label);
    if (isCursorLine(tail[i])) state.selected = state.options.length - 1;
  }
  return start;
}

function formatInteractivePrompt(state, response) {
  const parts = [];
  // For menu-type prompts (select/permission/confirm) the raw response IS the
  // on-screen menu, which we re-render cleanly below — prepending it would show
  // the menu twice (and the raw copy drops the cursor row / mangles numbering).
  // Only prepend the response for text-input/unknown, where it carries context.
  const isMenu = state.type === 'select' || state.type === 'multi_select' ||
    state.type === 'permission' || state.type === 'confirm';
  if (response && !isMenu) parts.push(response);

  if (state.prompt && (!response || isMenu || !response.includes(state.prompt))) {
    parts.push(`**${state.prompt}**`);
  }

  if (state.type === 'permission') {
    parts.push('⚠️ 需要权限确认');
    parts.push('回复 “确认/yes” 允许，“取消/no” 拒绝');
  } else if (state.type === 'confirm') {
    parts.push('回复 “确认/yes” 继续，“取消/no” 取消');
  } else if (state.type === 'multi_select' && state.options.length) {
    const checked = state.checked || [];
    const kinds = state.optionKinds || [];
    state.options.forEach((option, index) => {
      // Type/chat rows aren't toggle items — show them without a checkbox.
      const box = (kinds[index] === 'choice' || kinds[index] === undefined)
        ? (checked[index] ? '☑' : '☐') + ' '
        : '';
      parts.push(`${box}${index + 1}. ${option}`);
    });
    parts.push('—— 多选：回复要勾选的序号（可多个，如 `1 3`），我会自动提交；直接回复文字＝自己输入；回复 “取消” 放弃');
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

module.exports = { parseInteractiveState, formatInteractivePrompt, normalizeInteractiveInput, cursorLineText };
