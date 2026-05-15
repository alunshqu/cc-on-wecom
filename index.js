require('dotenv').config();

const SessionStore = require('./src/session/session-store');
const { WebAdapter, WeComAdapter, ChannelRegistry } = require('./src/channel');
const { RichRenderer } = require('./src/interaction');
const { log } = require('./src/shared/logger');

const store = new SessionStore();
store.restore();

const registry = new ChannelRegistry();

const webAdapter = new WebAdapter({
  store,
  renderer: new RichRenderer(),
});
registry.register(webAdapter);

const wecomAdapter = new WeComAdapter({
  store,
  renderer: new RichRenderer(),
});
registry.register(wecomAdapter);

registry.startAll().then(() => {
  log('server', `cc-on-wecom started. Channels: ${[...registry.adapters.keys()].join(', ')}`);

  for (const [id, session] of store.sessions) {
    if (id === 'wecom_warmup') continue;
    if (!session.agent.alive) {
      session.start();
      log('server', `Started restored session: ${id}`);
    }
  }
}).catch((e) => {
  log('server', `Startup failed: ${e.message}`);
  process.exit(1);
});

process.on('SIGINT', () => {
  log('server', 'Shutting down...');
  registry.stopAll().then(() => process.exit(0));
});

process.on('SIGTERM', () => {
  log('server', 'Shutting down...');
  registry.stopAll().then(() => process.exit(0));
});
