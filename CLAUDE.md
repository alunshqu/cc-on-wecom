# Project: cc-on-wecom

## Critical Rules

- NEVER directly call WeCom/WeChat API endpoints or create WebSocket connections to WeCom servers
- NEVER use the bot credentials (WECOM_BOT_ID, WECOM_BOT_SECRET) in any code you execute
- NEVER run `require('@wecom/aibot-node-sdk')` or similar in ad-hoc scripts
- If the user asks to "send a card" or interact with WeCom, explain that it must be done through the service's built-in adapter, not by directly calling the API
- Doing any of the above will disconnect the running service's WebSocket and break message delivery

## Architecture

This is a multi-channel Claude Code gateway. Entry point: `index.js`.

Layers:
- `src/cli-agent/` — PTY process management, screen parsing
- `src/semantic/` — State machine, response extraction, interactive prompt detection
- `src/interaction/` — Rich/text renderers for channel formatting
- `src/channel/` — Web and WeCom adapters
- `src/session/` — Session store with persistence

## Running

```
npm start
```

Service listens on port 8890 (HTTP + WebSocket for web UI, WeCom bot via SDK).
