const Renderer = require('./renderer');

class RichRenderer extends Renderer {
  constructor() {
    super({ markdown: true, buttons: true, cards: true, streaming: true, maxLen: 20000 });
  }

  renderResponse(response) {
    const msg = { type: 'markdown', content: response.text, mode: 'new' };
    if (response.toolsUsed && response.toolsUsed.length) {
      msg.metadata = { toolsUsed: response.toolsUsed };
    }
    return msg;
  }

  renderResponseChunk(chunk) {
    return { type: 'markdown', content: chunk.text, mode: 'replace' };
  }

  renderPermissionPrompt(prompt) {
    return {
      type: 'card',
      content: prompt.message || `${prompt.tool}: ${prompt.description}`,
      buttons: [
        { label: '✅ 允许', action: 'approve' },
        { label: '❌ 拒绝', action: 'deny' },
      ],
      mode: 'new',
    };
  }

  renderInteractivePrompt(prompt) {
    const msg = { type: 'markdown', content: prompt.message, mode: 'new' };
    if (prompt.state && prompt.state.options.length) {
      msg.buttons = prompt.state.options.map((opt, i) => ({
        label: opt,
        action: `option:${i + 1}`,
      }));
      msg.type = 'card';
    }
    return msg;
  }

  renderToolUse(event) {
    if (event.status === 'started') {
      return { type: 'markdown', content: `⚙️ ${event.tool}...`, mode: 'new', metadata: { collapsed: true } };
    }
    if (event.status === 'completed' && event.summary) {
      return { type: 'markdown', content: `✅ ${event.tool}: ${event.summary}`, mode: 'replace', metadata: { collapsed: true } };
    }
    return null;
  }

  renderStateChange(from, to) {
    if (to === 'processing') return { type: 'text', content: '⏳', mode: 'new' };
    return null;
  }
}

module.exports = RichRenderer;
