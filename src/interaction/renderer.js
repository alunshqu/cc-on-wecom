class Renderer {
  constructor(capabilities = {}) {
    this.capabilities = {
      markdown: capabilities.markdown !== false,
      buttons: Boolean(capabilities.buttons),
      cards: Boolean(capabilities.cards),
      streaming: Boolean(capabilities.streaming),
      maxLen: capabilities.maxLen || 20000,
    };
  }

  renderResponse(response) { return { type: 'text', content: response.text, mode: 'new' }; }
  renderResponseChunk(chunk) { return { type: 'text', content: chunk.text, mode: 'replace' }; }
  renderPermissionPrompt(prompt) { return { type: 'text', content: prompt.message, mode: 'new' }; }
  renderInteractivePrompt(prompt) { return { type: 'text', content: prompt.message, mode: 'new' }; }
  renderToolUse(event) { return null; }
  renderStateChange(from, to) { return null; }
  renderError(err) { return { type: 'text', content: `Error: ${err.message || err}`, mode: 'new' }; }
}

module.exports = Renderer;
