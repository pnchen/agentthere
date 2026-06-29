# AgentThere Protocol Specification (English)

- **Signaling layer**: MQTT broker, used only for SDP/ICE exchange and peer discovery; no chat data is sent through the broker
- **Data layer**: WebRTC DataChannel (ordered SCTP) carries all messages
- **Media layer**: Dedicated WebRTC MediaTrack (Opus RTP) carries audio

---

## 1. MQTT Signaling

### 1.1 Topic Naming

All topic IDs use the first 12 hex characters of a SHA256 hash; the raw identifiers never appear on the broker.

| Purpose | Topic |
|------|-------|
| Peer discovery | `{ns}/h(group)/query` |
| Peer answer | `{ns}/h(group)/h(peer)/answer` |
| Graceful leave | `{ns}/h(group)/bye` |
| Unexpected disconnect (Will) | `{ns}/h(group)/will` |
| SDP exchange | `{ns}/h(peerA)2h(peerB)/description` |
| ICE exchange | `{ns}/h(peerA)2h(peerB)/candidate` |
| Media SDP | `{ns}/h(peerA)2h(peerB)/description` (with `tag`) |
| Media ICE | `{ns}/h(peerA)2h(peerB)/candidate` (with `tag`) |

`ns` is an optional namespace; different deployments on the same broker are isolated by namespace.

### 1.2 Discovery Flow

```
Browser                         Agent
  │                              │
  │  PUB query { answer_to, id } │
  ├─────────────────────────────►│
  │                              │
  │  PUB answer { id }           │
  │◄─────────────────────────────┤
  │                              │
  │  Establish WebRTC connection  │
  │◄════════════════════════════►│
  │                              │
  │  PUB bye { id }              │
  ├─────────────────────────────►│
  │                              │
  │  will { id }                 │
  │  ← published by the MQTT broker
```

**Leave notice vs disconnect notice**:
- `bye` — sent on graceful leave; means “I have exited”, and the peer is removed immediately
- `will` — published by the MQTT broker on unexpected disconnect; means “the peer went offline”, and the peer is kept briefly so a quick reconnect can restore it

### 1.3 SDP / ICE

```json
// SDP
{ "description": { "type": "offer" | "answer", "sdp": "..." } }

// ICE
{ "candidate": { "candidate": "...", "sdpMid": "0", "sdpMLineIndex": 0 } }
```

### 1.4 Media Signaling

Audio uses a separate PeerConnection, distinguished by the `tag` field:

| tag | Direction | Purpose |
|-----|------|------|
| `media:<peerId>` | Browser → AgentThere | Browser microphone (sendonly) |
| `media:<agentId>` | AgentThere → Browser | TTS audio (sendonly) |
| (none) | Bidirectional | Main DataChannel |

```json
// SDP with tag
{ "tag": "media:peer123", "description": { "type": "offer", "sdp": "..." } }

// ICE with tag
{ "tag": "media:peer123", "candidate": { ... } }
```

---

## 2. DataChannel Messages

### 2.1 Browser → AgentThere

#### Profile Exchange

After the connection is established, both sides exchange profiles over the DataChannel (DTLS encrypted):

```json
{
  "type": "profile",
  "profile": { "name": "username", "avatar": "url", "uid": "<persistent-id>" }
}
```

`uid` is transmitted only through the DataChannel, not through MQTT.

#### Text Message

```json
{
  "id": "agentthere-1719391200000-x7k2m9",
  "text": "hello",
  "from": { "name": "username", "avatar": "url" }
}
```

#### File Metadata

```json
{
  "id": "agentthere-1719391200000-x7k2m9",
  "file": { "name": "photo.jpg", "size": 102400, "type": "image/jpeg" },
  "object_id": "abc123",
  "from": { "name": "username", "avatar": "url" }
}
```

#### File Chunk

```json
{
  "object_id": "abc123",
  "chunk": { "object_id": "abc123", "offset": 0, "data": "<Base64>" }
}
```

Chunk size is 64 KB. The receiver assembles chunks in `offset` order and uses the accumulated byte count versus `file.size` to determine completion.

### 2.2 AgentThere → Browser (Agent Reply)

Agent replies use the `_patch` streaming protocol. All updates for the same reply share the same `id`.

#### Lifecycle

```
placeholder → model_info → reasoning → tool calls → text stream → loading:false → usage
```

The order is not fixed; text and tool updates may interleave freely.

#### Placeholder Message

```json
{ "id": "agentthere-...", "text": "", "from": { "name": "Agent", "agent": true }, "loading": true }
```

#### Model Info

```json
{ "id": "agentthere-...", "model_info": { "model": "...", "provider": "...", "thinkLevel": "..." } }
```

#### `_patch` Streaming Protocol

All incremental updates are expressed as a `_patch` array:

```json
{
  "id": "agentthere-...",
  "_patch": [
    { "op": "push", "path": "segments", "value": { "sid": "s1", "kind": "text", "text": "" } },
    { "op": "append_text", "path": "segments[sid=s1].text", "chunk": "hello" }
  ]
}
```

##### Operation Set

| op | Meaning | Fields |
|----|------|------|
| `set` | Replace value | `path`, `value` |
| `merge` | Shallow-merge object | `path`, `value` |
| `push` | Append to array | `path`, `value` |
| `append_text` | Append to string | `path`, `chunk` |
| `remove` | Remove key or array element | `path` |

##### Path Syntax

- Dot notation: `segments.0.text`
- Key selector: `segments[sid=s2]` (find the first element whose `sid` matches)
- Path resolution failures are ignored silently

##### Segment Structure

A segment is a time-ordered element in `segments[]`. There are two kinds:

**text**:
```json
{ "sid": "s1", "kind": "text", "text": "accumulated text", "complete": false }
```

**tool**:
```json
{
  "sid": "s2", "kind": "tool",
  "name": "exec", "argsSummary": "python ...",
  "phase": "start", "status": "running",
  "events": []
}
```

Each item in `events[]` can be a `command` event (with `output`, `exitCode`), a `patch` event (with `added/modified/deleted`), or a generic event.

##### Examples

```js
// text stream
{ id, _patch: [{ op: "push", path: "segments", value: { sid:"s1", kind:"text", text:"" } },
               { op: "append_text", path: "segments[sid=s1].text", chunk: "hello" }] }

// tool call
{ id, _patch: [{ op: "merge", path: "segments[sid=s1]", value: { complete:true } },
               { op: "push", path: "segments", value: { sid:"s2", kind:"tool", name:"exec", ... } }] }

// tool output
{ id, _patch: [{ op: "push", path: "segments[sid=s2].events",
                 value: { kind:"command", output:"5050\n" } }] }

// finish
{ id, _patch: [{ op: "set", path: "loading", value: false }] }
```

#### Reasoning

```json
{ "id": "...", "_patch": [{ "op": "append_text", "path": "reasoning", "chunk": "let me think..." }] }
{ "id": "...", "_patch": [{ "op": "set", "path": "reasoning_complete", "value": true }] }
```

#### Token Usage

```json
{ "id": "...", "usage": { "input": 1500, "output": 800, "total": 2300, "summary": "..." } }
```

---

## 3. File Transfer

| Parameter | Value |
|------|-----|
| Chunk size | 64 KB |
| Encoding | Base64 |
| Backpressure threshold | 256 KB (`bufferedAmount`) |
| Timeout | drain 30s / overall 5min |
| Delivery guarantee | ordered SCTP |

### Backpressure

Before sending each chunk, check `DataChannel.bufferedAmount()`: send immediately when `< 256 KB`; when `>= 256 KB`, wait for `onBufferedAmountLow`; give up after a 30s timeout.
