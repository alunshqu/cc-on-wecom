const { getScreenLines } = require('../cli-agent/screen-parser');

function isNoiseLine(line) {
  if (/^[─━╭╰╮╯│╌┌┐└┘├┤┬┴┼═║╔╗╚╝╠╣╦╩╬\s]+$/.test(line)) return true;
  if (/^⏵⏵/.test(line)) return true;
  if (/^Using\s/.test(line)) return true;
  if (/^[✻●⏺◐◑◒◓⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*\w+ing\b/.test(line)) return true;
  if (/^[✻●⏺]\s*\w+ed\s+(in|for)\s+[\d.]+/.test(line)) return true;
  if (/esc to interrupt/i.test(line)) return true;
  if (/\d+\s*tokens/.test(line)) return true;
  if (/\$[\d.]+\s*(cost|spent)/i.test(line)) return true;
  if (/context:?\s*[\d.]+[km]?\s*\/\s*[\d.]+[km]?/i.test(line)) return true;
  if (/bypass permissions|shift\+tab/i.test(line)) return true;
  if (/type your message/i.test(line)) return true;
  if (/^\[附件:/.test(line)) return true;
  if (/^Read \d+ (file|line)/.test(line)) return true;
  if (/^(Listed|Read|Found|Wrote|Created|Executed|Edited|Deleted|Searched|Ran)\s+\d+/.test(line)) return true;
  if (/^(Bash|Read|Write|Edit|Grep|Glob|WebFetch|WebSearch|Agent)\s*[:(]/.test(line)) return true;
  if (/^[\/~][\w\/.@-]+:\d+/.test(line)) return true;
  if (/[█▓▒░]{3,}/.test(line)) return true;
  if (/^❯\s*$/.test(line)) return true;
  if (/^❯\s+\S/.test(line)) return true;
  if (/^(Model|Session|Mode|Project):?\s/i.test(line)) return true;
  if (/^Compacted\s/i.test(line)) return true;
  if (/auto-compact/i.test(line)) return true;
  return false;
}

function findPromptForRequest(lines, requestText, searchStart) {
  if (!requestText) return -1;
  const normalizedRequest = String(requestText).trim();
  for (let i = searchStart; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('❯')) continue;
    const promptText = line.replace(/^❯\s*/, '').trim();
    if (promptText === normalizedRequest) return i;
  }
  return -1;
}

function extractResponse(vt, requestText) {
  const lines = getScreenLines(vt);

  let lastEmptyPrompt = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^❯\s*$/.test(lines[i].trim())) {
      lastEmptyPrompt = i;
      break;
    }
  }

  let userMsgPrompt = -1;
  const searchStart = lastEmptyPrompt !== -1 ? lastEmptyPrompt - 1 : lines.length - 1;
  userMsgPrompt = findPromptForRequest(lines, requestText, searchStart);
  for (let i = searchStart; userMsgPrompt === -1 && i >= 0; i--) {
    if (/^❯\s+\S/.test(lines[i])) {
      userMsgPrompt = i;
      break;
    }
  }
  if (userMsgPrompt === -1) return null;

  const endLine = lastEmptyPrompt !== -1 ? lastEmptyPrompt : lines.length;
  const result = [];
  for (let i = userMsgPrompt + 1; i < endLine; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    if (isNoiseLine(trimmed)) continue;
    result.push(trimmed.replace(/^[✻●⏺◐◑◒◓]\s*/, ''));
  }
  while (result.length && !result[0]) result.shift();
  while (result.length && !result[result.length - 1]) result.pop();
  return result.join('\n').trim() || null;
}

module.exports = { extractResponse, isNoiseLine, findPromptForRequest };
