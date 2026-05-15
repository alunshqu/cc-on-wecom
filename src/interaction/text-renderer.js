const Renderer = require('./renderer');

class TextRenderer extends Renderer {
  constructor() {
    super({ markdown: false, buttons: false, cards: false, streaming: false, maxLen: 2000 });
  }

  renderResponse(response) {
    let content = response.text || '';
    if (content.length > this.capabilities.maxLen) {
      content = content.substring(0, this.capabilities.maxLen - 20) + '\n...(已截断)';
    }
    return { type: 'text', content, mode: 'new' };
  }

  renderPermissionPrompt(prompt) {
    const content = `${prompt.message || prompt.description}\n\n回复 y 允许，n 拒绝`;
    return { type: 'text', content, mode: 'new' };
  }

  renderInteractivePrompt(prompt) {
    return { type: 'text', content: prompt.message, mode: 'new' };
  }

  renderToolUse(event) {
    if (event.status === 'completed' && event.summary) {
      const summary = event.summary.length > 100 ? event.summary.substring(0, 100) + '...' : event.summary;
      return { type: 'text', content: `[${event.tool}] ${summary}`, mode: 'new' };
    }
    return null;
  }

  renderStateChange(from, to) {
    return null;
  }
}

module.exports = TextRenderer;
