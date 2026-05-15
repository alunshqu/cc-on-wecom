const { log } = require('../shared/logger');

class SessionRouter {
  constructor(store, registry) {
    this.store = store;
    this.registry = registry;
  }

  route(inbound) {
    const { userId, channelId, text } = inbound;
    let session = this.store.getByUser(userId);

    if (!session) {
      const id = `${channelId}_${userId.slice(-6)}`;
      session = this.store.create(id, { cwd: process.env.HOME });
      this.store.setUserSession(userId, id);
      session.start();
      log('router', `Created session ${id} for user ${userId}`);
    }

    return session;
  }

  bindSession(session, channelAdapter) {
    session.on('response-complete', ({ text }) => {
      if (!text) return;
      const rendered = channelAdapter.renderer.renderResponse({ text });
      channelAdapter.broadcast(session.id, rendered);
    });

    session.on('state-change', ({ from, to }) => {
      const rendered = channelAdapter.renderer.renderStateChange(from, to);
      if (rendered) channelAdapter.broadcast(session.id, rendered);
    });

    session.on('interactive-prompt', ({ message }) => {
      const rendered = channelAdapter.renderer.renderInteractivePrompt({ message });
      if (rendered) channelAdapter.broadcast(session.id, rendered);
    });
  }
}

module.exports = SessionRouter;
