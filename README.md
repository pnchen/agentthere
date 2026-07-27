# AgentThere

> WebRTC direct channel for real-time collaboration with AI agents.

[English](README.md) | [中文](README.zh.md)

AgentThere connects browsers to AI agents over WebRTC for low-latency text, voice, and file exchange. MQTT is used for discovery and signaling; session data stays on the peer-to-peer path. Powered by the [Pi coding agent SDK](https://github.com/earendil-works/pi-coding-agent).

> 🚀 **[Live Demo](https://pnchen.github.io/agentthere/demo/)**

## Quick Start

### Prerequisites

- Node.js ≥ 18
- An MQTT broker ([EMQX](https://www.emqx.io/), [Mosquitto](https://mosquitto.org/), etc.)
- A Pi coding agent API key

### 1. Install

```bash
cd pi-channel
npm install
```

### 2. Configure

Create `~/.agentthere/agentthere.json` (or set `AGENTTHERE_HOME`):

```json
{
  "mqtt": {
    "url": "wss://your-broker:8084/mqtt",
    "username": "user",
    "password": "pass"
  },
  "ice_servers": [
    { "urls": "stun:stun.l.google.com:19302" }
  ],
  "agents": {
    "default": {
      "model": "deepseek/deepseek-chat",
      "workspace": "/path/to/agent-workspace"
    }
  },
  "groups": {
    "hello": {
      "agent": "default"
    }
  }
}
```

#### Top-level fields

| Field | Required | Description |
|---|---|---|
| `mqtt` | ✓ | MQTT broker connection |
| `ice_servers` |  | STUN/TURN servers (defaults to Google STUN) |
| `agents` | ✓ | Agent definitions; key is the config alias |
| `groups` | ✓ | Group definitions; key is the group name |

#### Agent fields

| Field | Required | Description |
|---|---|---|
| `model` | ✓ | Model ID in `provider/model` format (e.g. `deepseek/deepseek-chat`) |
| `workspace` |  | Agent workspace directory (defaults to `workspaces/<key>` under config home) |
| `stt` |  | Speech-to-text config with `wss` and `api_key` (optional, for voice) |
| `tts` |  | Text-to-speech config with `providers` and `personas` (optional, for voice) |
| `skills` |  | Per-skill environment variables |
| `thinking_level` |  | Thinking budget: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"` |

#### Group fields

| Field | Required | Description |
|---|---|---|
| `agent` | ✓ | Agent config key to bind |

Access control uses `users.jsonl` in the config home directory (pair-code based authorization).

### 3. Run

```bash
node pi-channel/service.js
```

### 4. Start the client

```bash
cd client
npm install
npm run dev
```

Open `http://localhost:5173`, enter a group name, and start chatting.

For production:

```bash
cd client
npm run build
# Serve client/dist with any static file server
```

## Architecture

```text
Browser (Vue 3 SPA)
    │
    │  MQTT signaling: discovery + SDP/ICE exchange
    ▼
Pi Channel Service (Node.js)
    │
    ├─ WebRTC DataChannel  → text chat, `_patch` stream, files
    └─ WebRTC MediaTrack   → Opus RTP voice traffic
    │
Pi Coding Agent SDK
```

### Transport

- **MQTT** — peer discovery and signaling
- **WebRTC DataChannel** — chat, streaming patches, file transfer
- **WebRTC MediaTrack** — microphone input and TTS output
- **DTLS** — peer-to-peer encryption

## Project structure

```text
agentthere/
├── pi-channel/             # Node.js channel service
│   ├── service.js          # Entry point
│   ├── src/
│   │   ├── agent.js        # Agent session management
│   │   ├── config.js       # Single-file configuration (JSON5)
│   │   ├── sdk-bridge.js   # Pi SDK ↔ channel protocol bridge
│   │   ├── channel/
│   │   │   ├── router/     # Koa-style middleware router
│   │   │   ├── middleware/ # intent, history, auth-gate
│   │   │   └── route/      # message, call handlers
│   │   ├── rtc/            # WebRTC peer connections & VAD
│   │   └── tools/          # Custom tools (file transfer, media)
├── client/                 # Browser SPA (Vue 3 + Vite)
└── LICENSE
```

## Tech stack

| Layer | Technology |
|---|---|
| Signaling | MQTT (WSS) |
| NAT traversal | STUN + TURN |
| Data channel | WebRTC DataChannel |
| Streaming | `_patch` JSON operations |
| Audio codec | Opus RTP |
| Service runtime | Node.js + node-datachannel |
| Agent SDK | Pi coding agent |
| Client | Vue 3 + Vite + WebRTC API |
| Voice VAD | Silero ONNX |

## License

MIT © AgentThere
