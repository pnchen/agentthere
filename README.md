# AgentThere

> OpenClaw's WebRTC direct channel for real-time collaboration with AI agents.

[English](README.md) | [中文](README.zh.md)

AgentThere connects browsers to an OpenClaw AI agent running on a local machine over WebRTC for low-latency text, voice, and file exchange. MQTT is used only for discovery and signaling; all session data stays on the peer-to-peer path.

> 🚀 **[Live Demo](https://pnchen.github.io/agentthere/demo/)**

## Why AgentThere

- **Small-team real-time collaboration** — a shared workspace for a small group working with an OpenClaw agent
- **Text, voice, and files in one place** — chat, calling, and file exchange in a single session
- **Local-first deployment** — OpenClaw runs on your own machine, not a public server
- **Controlled access** — peer admission through OpenClaw pairing

## Quick Start

### Prerequisites

- [OpenClaw Gateway](https://docs.openclaw.ai/start/getting-started) running locally on your machine
- An MQTT broker such as [EMQX](https://www.emqx.io/) or [Mosquitto](https://mosquitto.org/)

### 1. Install the plugin

```bash
cd openclaw-plugin/channel
npm install
cd ../..
openclaw plugins install --link ./openclaw-plugin/channel
```

### 2. Configure `~/.openclaw/openclaw.json`

```json
{
  "channels": {
    "agentthere": {
      "enabled": true,
      "dmPolicy": "pairing",
      "mqtt": {
        "url": "wss://your-broker:8084/mqtt",
        "username": "user",
        "password": "pass",
        "namespace": "my-namespace"
      },
      "iceServers": [
        { "urls": "stun:stun.l.google.com:19302" }
      ],
      "groups": {
        "hello": {
          "openclaw_agent_id": "my-agent",
          "systemPrompt": "You are a helpful assistant.",
          "skills": ["coding"],
          "verbose": "on"
        }
      }
    }
  }
}
```

#### Channel configuration

| Field | Required | Type | Description |
|------|:--:|------|------|
| `enabled` | ✓ | boolean | Enable the channel |
| `mqtt.url` | ✓ | string | MQTT broker URL (`wss://`) |
| `mqtt.namespace` |  | string | Topic prefix for isolating multiple deployments; must match on both sides |
| `mqtt.username` |  | string | MQTT username |
| `mqtt.password` |  | string | MQTT password |
| `dmPolicy` |  | string | Defaults to `pairing`; controls how new peers are admitted |
| `iceServers` |  | array | STUN/TURN server list |
| `allowFrom` |  | array | Allowlist of peer UIDs |
| `groups` | ✓ | object | Group configuration; keys are group names |

#### Group configuration

| Field | Description |
|------|------|
| `openclaw_agent_id` | Binds the group to a specific agent |
| `systemPrompt` | Group-level system prompt |
| `skills` | Restricts available skills |
| `verbose` | When set to `"on"`, shows tool-call details in the client |

### 3. Start the client

```bash
cd client
npm install
npm run dev
```

Open `http://localhost:5173`, enter a group name, and start chatting.

Production build:

```bash
npm run build
# Serve client/dist with any static file server
```

### Optional: Install the STT plugin

Voice uses OpenClaw Voice Realtime by default. If you want Aliyun ASR, install the STT plugin:

```bash
cd openclaw-plugin/stt
npm install
cd ../..
openclaw plugins install --link ./openclaw-plugin/stt
```

## How it works

```text
Browser (Vue 3 SPA)
    │
    │  MQTT signaling: discovery + SDP/ICE exchange only
    ▼
AgentThere Plugin (node-datachannel)
    │
    ├─ WebRTC DataChannel  → text chat, `_patch` stream, files
    └─ WebRTC MediaTrack   → Opus RTP voice traffic

OpenClaw Gateway / AI Agent Loop
```

### Transport roles

- **MQTT** — peer discovery and signaling only
- **WebRTC DataChannel** — chat messages, streaming patches, file metadata, and file chunks
- **WebRTC MediaTrack** — microphone input and TTS output
- **DTLS** — encryption for peer-to-peer traffic

## What you can build on top

- **Exploratory small-team collaboration** — a shared live workspace where a small group of people and an OpenClaw agent can brainstorm, test ideas, and iterate in real time
- Voice-first agent interfaces
- File-aware assistant flows
- Mobile or desktop WebRTC clients
- Lightweight embedded clients with the same channel protocol

The current browser client is a reference implementation; the same channel can be extended to other WebRTC frontends.

## Project structure

```text
agentthere/
├── openclaw-plugin/
│   ├── channel/            # AgentThere channel plugin
│   └── stt/                # Optional STT plugin
├── client/                 # Browser SPA (Vue 3 + Vite)
├── docs/
│   ├── SPEC.en.md          # Protocol spec (English)
│   └── SPEC.zh.md          # Protocol spec (Chinese)
└── LICENSE
```

## Tech stack

| Layer | Technology |
|---|---|
| Signaling | MQTT (WSS) |
| NAT traversal | STUN + TURN |
| Data channel | WebRTC DataChannel |
| Streaming protocol | `_patch` JSON ops |
| Audio codec | Opus RTP |
| Gateway | Node.js + node-datachannel |
| Client | Vue 3 + Vite + WebRTC API |
| Voice VAD | Silero ONNX |
| Storage | IndexedDB |

## Documentation

- [SPEC.en.md](docs/SPEC.en.md) — protocol spec: MQTT topics, DataChannel message formats, `_patch` operations, and file transfer

## License

MIT © AgentThere
