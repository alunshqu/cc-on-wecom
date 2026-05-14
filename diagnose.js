#!/usr/bin/env node
// Standalone diagnostic script — run with: node diagnose.js <PID>
// Or: node diagnose.js --dump (dump all claude-related processes)

const { execSync } = require('child_process');

function run(cmd) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim(); } catch(e) { return `[error: ${e.message}]`; }
}

function diagnose(pid) {
  console.log(`\n=== Diagnostic Report for PID ${pid} ===`);
  console.log(`Time: ${new Date().toISOString()}\n`);

  // 1. Process alive?
  const alive = run(`kill -0 ${pid} 2>&1; echo $?`);
  console.log(`1. Process alive: ${alive.includes('0') ? 'YES' : 'NO'}`);

  // 2. Process state
  console.log(`\n2. Process state:`);
  console.log(run(`ps -o pid,state,etime,rss,vsz,%cpu,%mem,command -p ${pid}`));

  // 3. File descriptors
  console.log(`\n3. Open file descriptors (PTY, pipes, sockets):`);
  const lsof = run(`lsof -p ${pid} 2>/dev/null | grep -E '(PIPE|PIPE|CHR|IPv|unix)' | head -20`);
  console.log(lsof || '  (none found)');

  // 4. Network connections
  console.log(`\n4. Network connections:`);
  const net = run(`lsof -i -p ${pid} 2>/dev/null | head -10`);
  console.log(net || '  (none)');

  // 5. PTY master fd
  console.log(`\n5. PTY file descriptors:`);
  const ptyFds = run(`lsof -p ${pid} 2>/dev/null | grep -E '(pts|ttys|ptmx)' | head -5`);
  console.log(ptyFds || '  (none found)');

  // 6. Thread state (macOS)
  console.log(`\n6. Thread info:`);
  const threads = run(`ps -M -p ${pid} 2>/dev/null | head -15`);
  console.log(threads || '  (unavailable)');

  // 7. Recent system calls (if dtruss available - needs sudo)
  console.log(`\n7. Last activity hint (from /tmp/happyweb-debug.log):`);
  try {
    const logs = run(`grep "\\[${pid === run("pgrep -f 'claude.*bypassPermissions' | head -1").trim() ? 'wecom_warmup' : ''}]\\|\\[wecom_" /tmp/happyweb-debug.log | tail -5`);
    console.log(logs || '  (no recent logs)');
  } catch(e) {
    console.log('  (could not read logs)');
  }

  console.log('\n=== End Diagnostic ===\n');
}

// Also dump HappyWeb server diagnostics
function diagnoseServer() {
  console.log('\n=== HappyWeb Server Diagnostic ===');
  const serverPid = run("pgrep -f 'node server.js' | head -1");
  if (serverPid) {
    console.log(`Server PID: ${serverPid}`);
    console.log(run(`ps -o pid,state,etime,rss,vsz,%cpu -p ${serverPid}`));
  } else {
    console.log('Server not running!');
  }
  console.log('=== End Server ===\n');
}

const arg = process.argv[2];
if (!arg || arg === '--dump') {
  // Dump all claude processes
  console.log('All Claude processes:');
  console.log(run("ps aux | grep claude | grep -v grep"));
  const pid = run("pgrep -f 'claude.*bypassPermissions' | head -1");
  if (pid) diagnose(pid);
  diagnoseServer();
} else {
  diagnose(parseInt(arg));
}
