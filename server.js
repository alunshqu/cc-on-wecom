require('dotenv').config({ override: true });
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const {
  createSession, sessions, sessionList, startClaude, log,
  sendToClaude, sendKeyToClaude, broadcast, broadcastAll,
  getScreenLines, getScreenText, detectScreenType, extractResponse,
  COLS, ROWS, UPLOAD_DIR, restorePersistedSessions, destroySession,
} = require('./session-manager');

const LOG_FILE = '/tmp/happyweb-debug.log';

// ── Multipart file upload parser ──────────────────────────────────────────
function parseMultipart(buf, boundary) {
  const boundaryBuf = Buffer.from('--' + boundary);
  const parts = [];
  let start = buf.indexOf(boundaryBuf) + boundaryBuf.length + 2;

  while (true) {
    const end = buf.indexOf(boundaryBuf, start);
    if (end === -1) break;

    const part = buf.slice(start, end - 2);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd === -1) { start = end + boundaryBuf.length + 2; continue; }

    const headers = part.slice(0, headerEnd).toString('utf8');
    const body = part.slice(headerEnd + 4);

    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);

    parts.push({
      name: nameMatch ? nameMatch[1] : null,
      filename: filenameMatch ? filenameMatch[1] : null,
      data: body,
    });

    start = end + boundaryBuf.length + 2;
    if (buf.slice(start, start + 2).toString() === '--') break;
    start += 2;
  }
  return parts;
}

function handleUpload(req, res) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'No boundary' }));
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try {
      const buf = Buffer.concat(chunks);
      const parts = parseMultipart(buf, boundaryMatch[1]);
      const filePart = parts.find(p => p.filename);
      if (!filePart || !filePart.data.length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No file found' }));
        return;
      }

      const safeName = Date.now() + '_' + filePart.filename.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');
      const filePath = path.join(UPLOAD_DIR, safeName);
      fs.writeFileSync(filePath, filePart.data);

      log('upload', `Saved: ${filePath} (${filePart.data.length} bytes, orig: ${filePart.filename})`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        path: filePath,
        originalName: filePart.filename,
        size: filePart.data.length,
      }));
    } catch (err) {
      log('upload', `Error: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

// ── HTTP Server ───────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'public', 'index.html'), (err, data) => {
      if (err) { res.writeHead(500); res.end('Error'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(data);
    });
    return;
  }
  if (req.url === '/upload' && req.method === 'POST') {
    handleUpload(req, res);
    return;
  }
  res.writeHead(404); res.end('Not found');
});

// ── WebSocket ─────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let currentSessionId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.type) {
      case 'create_session': {
        const id = crypto.randomUUID().slice(0, 8);
        const session = createSession(id, msg.cwd);
        session.clients.add(ws);
        currentSessionId = id;
        ws.send(JSON.stringify({ type: 'session_created', sessionId: id }));
        broadcastAll({ type: 'sessions', sessions: sessionList() });
        startClaude(session);
        break;
      }
      case 'join_session': {
        const session = sessions.get(msg.sessionId);
        if (!session) { ws.send(JSON.stringify({ type: 'error', text: 'Not found' })); return; }
        if (currentSessionId) { const prev = sessions.get(currentSessionId); if (prev) prev.clients.delete(ws); }
        session.clients.add(ws);
        currentSessionId = msg.sessionId;
        ws.send(JSON.stringify({ type: 'history', messages: session.history, sessionId: session.id }));
        ws.send(JSON.stringify({ type: 'status', status: session.status, sessionId: session.id }));
        break;
      }
      case 'send': {
        const session = sessions.get(msg.sessionId || currentSessionId);
        if (!session) { ws.send(JSON.stringify({ type: 'error', text: 'Not found' })); return; }
        const result = sendToClaude(session, msg.text);
        if (!result.ok) ws.send(JSON.stringify({ type: 'error', text: result.error }));
        break;
      }
      case 'keypress': {
        const session = sessions.get(msg.sessionId || currentSessionId);
        if (!session) { ws.send(JSON.stringify({ type: 'error', text: 'Not found' })); return; }
        const key = msg.key;
        if (key === 'shift+tab') {
          sendKeyToClaude(session, 'shift+tab');
        } else if (key === 'escape') {
          if (session.ptyProc) { session.ptyProc.write('\x1b'); log(session.id, 'Sent Escape'); }
        } else if (key === 'ctrl+c') {
          sendKeyToClaude(session, 'ctrl+c');
        }
        break;
      }
      case 'debug_screen': {
        const session = sessions.get(msg.sessionId || currentSessionId);
        if (!session) { ws.send(JSON.stringify({ type: 'error', text: 'Not found' })); return; }
        const lines = getScreenLines(session.vt);
        ws.send(JSON.stringify({
          type: 'debug_screen', sessionId: session.id,
          phase: session.phase, screenType: detectScreenType(getScreenText(session.vt)),
          sentTrustEnter: session.sentTrustEnter, onDataCount: session.onDataCount,
          lines: lines.filter(l => l.trim()),
        }));
        break;
      }
      case 'list_sessions': {
        ws.send(JSON.stringify({ type: 'sessions', sessions: sessionList() }));
        break;
      }
      case 'delete_session': {
        const sid = msg.sessionId;
        destroySession(sid, { deleteState: true });
        broadcastAll({ type: 'sessions', sessions: sessionList() });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentSessionId) { const s = sessions.get(currentSessionId); if (s) s.clients.delete(ws); }
  });
});

// ── Start ─────────────────────────────────────────────────────────────────
restorePersistedSessions({ start: true });

const PORT = process.env.PORT || 8890;
server.listen(PORT, () => {
  log('server', `HappyWeb listening on http://localhost:${PORT}`);
  console.log(`HappyWeb listening on http://localhost:${PORT}`);
});

// ── WeCom bot (optional) ─────────────────────────────────────────────────
try {
  require('./wecom');
} catch (e) {
  log('server', `WeCom bot load error: ${e.message}`);
  console.log(`WeCom bot not loaded: ${e.message}`);
}
