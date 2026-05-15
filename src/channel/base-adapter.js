const EventEmitter = require('events');

class BaseAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    this.name = options.name || 'unknown';
    this.renderer = options.renderer || null;
  }

  async start() { throw new Error('start() not implemented'); }
  async stop() { throw new Error('stop() not implemented'); }

  async send(userId, message) { throw new Error('send() not implemented'); }
  async edit(userId, messageId, message) { throw new Error('edit() not implemented'); }
  async sendTyping(userId) {}

  broadcast(sessionId, message) {}
}

module.exports = BaseAdapter;
