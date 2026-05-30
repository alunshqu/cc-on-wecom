#!/usr/bin/env node
// Benchmark: simulate ConPTY-style fragmented onData and measure how much
// screen parsing work the pipeline does. Run: node bench-parse.js
//
// This drives the REAL screen-parser + a stand-in for the onData hot path so
// we can compare detectScreenType call counts and wall time before/after the
// throttling change.

const { createTerminal, getScreenText, detectScreenType, ROWS } = require('./src/cli-agent/screen-parser');

// ---- Build a realistic Claude TUI frame (spinner animation + box) ----
function buildFrame(spinnerChar, elapsed) {
  const lines = [];
  lines.push('╭─────────────────────────────────────────────────────────────╮');
  lines.push('│ > 帮我看看这个项目                                            │');
  lines.push('╰─────────────────────────────────────────────────────────────╯');
  lines.push('');
  lines.push(`${spinnerChar} Thinking… (${elapsed}s · esc to interrupt)`);
  lines.push('');
  lines.push('⏺ Reading files and analyzing the codebase structure now.');
  lines.push('');
  for (let i = 0; i < 8; i++) lines.push(`  detail line ${i} with some content to fill the screen`);
  lines.push('');
  lines.push('❯ ');
  lines.push('  bypass permissions · shift+tab to cycle');
  return lines.join('\r\n') + '\r\n';
}

// ConPTY tends to deliver output in many small fragments. Simulate that by
// chopping each frame into ~12-byte chunks (Linux PTY would deliver 1 big chunk).
function fragment(str, size) {
  const out = [];
  for (let i = 0; i < str.length; i += size) out.push(str.slice(i, i + size));
  return out;
}

const SPINNERS = ['✻', '✢', '✳', '∗', '✻', '✢'];
const FRAMES = 60;              // ~6s of spinner at 10fps
const CHUNK_SIZE = 12;          // ConPTY-ish fragment size

// ---- Simulate the CURRENT hot path (per-chunk full re-parse) ----
function runCurrent() {
  const vt = createTerminal();
  let detectCalls = 0;
  let getTextCalls = 0;
  let lastType = '';

  const t0 = process.hrtime.bigint();
  for (let f = 0; f < FRAMES; f++) {
    const frame = buildFrame(SPINNERS[f % SPINNERS.length], (f / 10).toFixed(1));
    for (const chunk of fragment(frame, CHUNK_SIZE)) {
      vt.write(chunk);
      // Mirror pty-process.onData: detect on every chunk...
      const text = getScreenText(vt); getTextCalls++;
      const screenType = detectScreenType(text); detectCalls++;
      if (screenType !== lastType) {
        lastType = screenType;
        getScreenText(vt); getTextCalls++;            // screen-change re-serialize
      }
      // ...plus state-machine.tick() does it AGAIN:
      const t2 = getScreenText(vt); getTextCalls++;
      detectScreenType(t2); detectCalls++;
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, detectCalls, getTextCalls };
}

const r = runCurrent();
console.log(`ROWS=${ROWS}  frames=${FRAMES}  chunkSize=${CHUNK_SIZE}`);
console.log(`[CURRENT] time=${r.ms.toFixed(1)}ms  detectScreenType calls=${r.detectCalls}  getScreenText calls=${r.getTextCalls}`);
