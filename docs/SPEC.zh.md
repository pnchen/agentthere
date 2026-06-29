# AgentThere 协议说明

- **信令层**: MQTT broker，仅用于 SDP/ICE 交换和节点发现，不传输聊天数据
- **数据层**: WebRTC DataChannel（SCTP 有序）承载所有消息
- **媒体层**: 独立 WebRTC MediaTrack（Opus RTP）承载音频

---

## 1. MQTT 信令

### 1.1 Topic 命名

所有 topic ID 使用 SHA256 哈希前 12 位，原始标识符不出现于 broker。

| 用途 | Topic |
|------|-------|
| 节点发现 | `{ns}/h(group)/query` |
| 节点应答 | `{ns}/h(group)/h(peer)/answer` |
| 主动离开 | `{ns}/h(group)/bye` |
| 异常断开 (Will) | `{ns}/h(group)/will` |
| SDP 交换 | `{ns}/h(peerA)2h(peerB)/description` |
| ICE 交换 | `{ns}/h(peerA)2h(peerB)/candidate` |
| 媒体 SDP | `{ns}/h(peerA)2h(peerB)/description` (带 `tag`) |
| 媒体 ICE | `{ns}/h(peerA)2h(peerB)/candidate` (带 `tag`) |

`ns` 为可选 namespace，同一 broker 上不同部署通过不同 namespace 隔离。

### 1.2 发现流程

```
浏览器                          Agent
  │                               │
  │  PUB query { answer_to, id }  │
  ├──────────────────────────────►│
  │                               │
  │  PUB answer { id }            │
  │◄──────────────────────────────┤
  │                               │
  │  建立 WebRTC 连接              │
  │◄═════════════════════════════►│
  │                               │
  │  PUB bye { id } (主动离开)     │
  ├──────────────────────────────►│
  │                               │
  │  will { id } (异常断开)        │
  │  ← 由 MQTT broker 代理发布     │
```

**离开通知与掉线通知**：
- `bye` — 主动离开时发送，表示“我已经退出了”，接收方立即移除
- `will` — 异常断开时由 MQTT broker 代发，表示“对方掉线了”；接收方会短暂保留，若很快重新上线就恢复


### 1.3 SDP / ICE

```json
// SDP
{ "description": { "type": "offer" | "answer", "sdp": "..." } }

// ICE
{ "candidate": { "candidate": "...", "sdpMid": "0", "sdpMLineIndex": 0 } }
```

### 1.4 媒体信令

音频使用独立 PeerConnection，通过 `tag` 字段区分：

| tag | 方向 | 用途 |
|-----|------|------|
| `media:<peerId>` | 浏览器 → AgentThere | 浏览器麦克风 (sendonly) |
| `media:<agentId>` | AgentThere → 浏览器 | TTS 音频 (sendonly) |
| (无) | 双向 | 主 DataChannel |

```json
// 带 tag 的 SDP
{ "tag": "media:peer123", "description": { "type": "offer", "sdp": "..." } }

// 带 tag 的 ICE
{ "tag": "media:peer123", "candidate": { ... } }
```

---

## 2. DataChannel 消息

### 2.1 浏览器 → AgentThere

#### Profile 交换

连接建立后双方通过 DataChannel 交换身份（DTLS 加密）：

```json
{
  "type": "profile",
  "profile": { "name": "用户名", "avatar": "url", "uid": "<persistent-id>" }
}
```

`uid` 仅经 DataChannel 传输，不经过 MQTT。

#### 文本消息

```json
{
  "id": "agentthere-1719391200000-x7k2m9",
  "text": "你好",
  "from": { "name": "用户名", "avatar": "url" }
}
```

#### 文件 — 元数据

```json
{
  "id": "agentthere-1719391200000-x7k2m9",
  "file": { "name": "photo.jpg", "size": 102400, "type": "image/jpeg" },
  "object_id": "abc123",
  "from": { "name": "用户名", "avatar": "url" }
}
```

#### 文件 — 分块

```json
{
  "object_id": "abc123",
  "chunk": { "object_id": "abc123", "offset": 0, "data": "<Base64>" }
}
```

分块大小 64KB，接收端按 `offset` 排序组装，累计字节数 vs `file.size` 判断完成。

### 2.2 AgentThere → 浏览器 (Agent 回复)

Agent 回复使用 `_patch` 流式协议。同一条回复的所有更新共享同一 `id`。

#### 生命周期

```
placeholder → model_info → reasoning → tool calls → text stream → loading:false → usage
```

顺序不固定，文本与工具可任意交错。

#### 占位消息

```json
{ "id": "agentthere-...", "text": "", "from": { "name": "Agent", "agent": true }, "loading": true }
```

#### 模型信息

```json
{ "id": "agentthere-...", "model_info": { "model": "...", "provider": "...", "thinkLevel": "..." } }
```

#### `_patch` 流式协议

所有增量更新统一通过 `_patch` 数组表达：

```json
{
  "id": "agentthere-...",
  "_patch": [
    { "op": "push", "path": "segments", "value": { "sid": "s1", "kind": "text", "text": "" } },
    { "op": "append_text", "path": "segments[sid=s1].text", "chunk": "你好" }
  ]
}
```

##### Op 集

| op | 语义 | 字段 |
|----|------|------|
| `set` | 覆盖值 | `path`, `value` |
| `merge` | 浅合并对象 | `path`, `value` |
| `push` | 数组末尾追加 | `path`, `value` |
| `append_text` | 字符串追加 | `path`, `chunk` |
| `remove` | 删除 key 或数组元素 | `path` |

##### Path 语法

- 点号分隔: `segments.0.text`
- Key 选择器: `segments[sid=s2]`（数组中找第一个 `sid` 匹配的元素）
- 路径解析失败静默忽略

##### Segment 结构

Segment 是 `segments[]` 中的时序元素，两种 kind：

**text**:
```json
{ "sid": "s1", "kind": "text", "text": "累积文本", "complete": false }
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

`events[]` 中每个事件可以是 `command`（含 `output`, `exitCode`）、`patch`（含 `added/modified/deleted`）或通用事件。

##### 示例

```
// 文本流
{ id, _patch: [{ op: "push", path: "segments", value: { sid:"s1", kind:"text", text:"" } },
               { op: "append_text", path: "segments[sid=s1].text", chunk: "你好" }] }

// 工具调用
{ id, _patch: [{ op: "merge", path: "segments[sid=s1]", value: { complete:true } },
               { op: "push", path: "segments", value: { sid:"s2", kind:"tool", name:"exec", ... } }] }

// 工具输出
{ id, _patch: [{ op: "push", path: "segments[sid=s2].events",
                 value: { kind:"command", output:"5050\n" } }] }

// 收尾
{ id, _patch: [{ op: "set", path: "loading", value: false }] }
```

#### Reasoning

```json
{ "id": "...", "_patch": [{ "op": "append_text", "path": "reasoning", "chunk": "让我想想..." }] }
{ "id": "...", "_patch": [{ "op": "set", "path": "reasoning_complete", "value": true }] }
```

#### Token 用量

```json
{ "id": "...", "usage": { "input": 1500, "output": 800, "total": 2300, "summary": "..." } }
```

---

## 3. 文件传输

| 参数 | 值 |
|------|-----|
| 分块大小 | 64 KB |
| 编码 | Base64 |
| 背压阈值 | 256 KB (`bufferedAmount`) |
| 超时 | drain 30s / 整体 5min |
| 传输保证 | SCTP 有序 |

### 背压

每 chunk 发送前检查 `DataChannel.bufferedAmount()`：< 256KB 立即发送，≥ 256KB 等待 `onBufferedAmountLow`，超时 30s 放弃。

---
