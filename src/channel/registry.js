const { log } = require('../shared/logger');

class ChannelRegistry {
  constructor() {
    this.adapters = new Map();
  }

  register(adapter) {
    this.adapters.set(adapter.name, adapter);
    log('registry', `Registered channel: ${adapter.name}`);
  }

  get(name) { return this.adapters.get(name); }

  async startAll() {
    for (const [name, adapter] of this.adapters) {
      try {
        await adapter.start();
        log('registry', `Started channel: ${name}`);
      } catch (e) {
        log('registry', `Failed to start ${name}: ${e.message}`);
      }
    }
  }

  async stopAll() {
    for (const [name, adapter] of this.adapters) {
      try { await adapter.stop(); } catch (_) {}
    }
  }
}

module.exports = ChannelRegistry;
