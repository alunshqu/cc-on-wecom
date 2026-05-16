const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const BaseAdapter = require('./base-adapter');
const { log } = require('../shared/logger');
const config = require('../shared/config');

class WebAdapter extends BaseAdapter {
  constructor(options = {}) {
    super({ name: 'web', renderer: options.renderer });
    this.port = options.port || config.server.port;
    this.store = options.store;
    this.router = options.router;
    this.server = null;
    this.wss = null;
    this._clients = new Map();
  }

  async start() {
    this.server = http.createServer((req, res) => this._handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this._handleConnection(ws));
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        log('web', `Listening on port ${this.port}`);
        resolve();
      });
    });
  }

  async stop() {
    if (this.wss) this.wss.close();
    if (this.server) this.server.close();
  }

  broadcast(sessionId, message) {
    const payload = JSON.stringify(message);
    for (const [ws, meta] of this._clients) {
      if (meta.sessionId === sessionId && ws.readyState === 1) {
        ws.send(payload);
      }
    }
  }

  broadcastAll(message) {
    const payload = JSON.stringify(message);
    for (const [ws] of this._clients) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  _handleHttp(req, res) {
    if (req.url === '/' || req.url === '/index.html') {
      const htmlPath = path.join(__dirname, '..', '..', 'public', 'index.html');
      try {
        const html = fs.readFileSync(htmlPath, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
      return;
    }
    if (req.url === '/health') {
      const sessions = this.store.list();
      const health = {
        status: 'ok',
        uptime: Math.round(process.uptime()),
        platform: process.platform,
        sessions: sessions.length,
        activeSessions: sessions.filter(s => s.status === 'idle' || s.status === 'processing').length,
        wsClients: this._clients.size,
        memory: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
      return;
    }
    if (req.url === '/upload' && req.method === 'POST') {
      this._handleUpload(req, res);
      return;
    }
    res.writeHead(404);
    res.end('Not Found');
  }

  _handleConnection(ws) {
    const meta = { sessionId: null };
    this._clients.set(ws, meta);
    ws.send(JSON.stringify({ type: 'sessions', sessions: this.store.list() }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        this._handleWsMessage(ws, meta, msg);
      } catch (e) {
        log('web', `WS parse error: ${e.message}`);
      }
    });

    ws.on('close', () => {
      this._clients.delete(ws);
    });
  }

  _handleWsMessage(ws, meta, msg) {
    switch (msg.type) {
      case 'create_session': {
        const id = `web_${Date.now().toString(36)}`;
        const session = this.store.create(id, { cwd: msg.cwd || require('../shared/platform').homedir() });
        session.start();
        this._bindSession(session);
        meta.sessionId = id;
        ws.send(JSON.stringify({ type: 'session_created', sessionId: id }));
        this.broadcastAll({ type: 'sessions', sessions: this.store.list() });
        break;
      }
      case 'join_session': {
        const session = this.store.get(msg.sessionId);
        if (!session) { ws.send(JSON.stringify({ type: 'error', text: 'Session not found' })); break; }
        meta.sessionId = msg.sessionId;
        ws.send(JSON.stringify({ type: 'history', messages: session.history, sessionId: msg.sessionId }));
        ws.send(JSON.stringify({ type: 'status', status: session.status, sessionId: msg.sessionId }));
        break;
      }
      case 'send': {
        const session = this.store.get(msg.sessionId);
        if (!session) { ws.send(JSON.stringify({ type: 'error', text: 'Session not found' })); break; }
        session.sendMessage(msg.text);
        break;
      }
      case 'keypress': {
        const session = this.store.get(msg.sessionId);
        if (session) session.sendKey(msg.key);
        break;
      }
      case 'list_sessions': {
        ws.send(JSON.stringify({ type: 'sessions', sessions: this.store.list() }));
        break;
      }
      case 'delete_session': {
        this.store.destroy(msg.sessionId);
        this.broadcastAll({ type: 'sessions', sessions: this.store.list() });
        break;
      }
    }
  }

  _bindSession(session) {
    if (session._webBound) return;
    session._webBound = true;
    session.on('user-message', (entry) => {
      this.broadcast(session.id, { type: 'message', ...entry, sessionId: session.id });
    });
    session.on('assistant-message', (entry) => {
      this.broadcast(session.id, { type: 'message', ...entry, sessionId: session.id });
    });
    session.on('state-change', ({ to }) => {
      const status = (to === 'idle' || to === 'awaiting_input') ? 'idle' : 'processing';
      this.broadcast(session.id, { type: 'status', status, sessionId: session.id });
      this.broadcastAll({ type: 'sessions', sessions: this.store.list() });
    });
  }

  bindAllSessions() {
    for (const [id, session] of this.store.sessions) {
      this._bindSession(session);
    }
  }

  _handleUpload(req, res) {
    const uploadDir = config.paths.uploads;
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const filename = `upload_${Date.now()}.bin`;
      const filePath = path.join(uploadDir, filename);
      fs.writeFileSync(filePath, body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: filePath }));
    });
  }
}

module.exports = WebAdapter;
