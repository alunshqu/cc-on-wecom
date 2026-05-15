const { getScreenLines } = require('../cli-agent/screen-parser');

function cleanInteractiveLine(line) {
  return String(line || '')
    .replace(/[╭╰╮╯│─━╌┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

  for (const line of tail) {
    let match = line.match(/^[❯>→\-*•○●◉☐☑✔\s]*(\d+)[.)、]\s+(.+)$/);
    if (match) {
      state.options.push(match[2].trim());
      if (/^[❯>→]/.test(line)) state.selected = state.options.length - 1;
      continue;
    }
    match = line.match(/^[❯>→\-*•○●◉☐☑✔\s]+([^\s].+)$/);
    if (match && !/^(Submit|Skills|Using|Context Usage)/i.test(match[1])) {
      const option = match[1].trim();
      if (option.length <= 80 && !/[？?]$/.test(option)) {
        state.options.push(option);
        if (/^[❯>→]/.test(line)) state.selected = state.options.length - 1;
      }
    }
  }

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
