# AgentThere

> WebRTC 直连通道，用于与 AI agent 实时协作。

[English](README.md) | 中文

AgentThere 通过 WebRTC 连接浏览器与 AI agent，支持低延迟的文本、语音和文件传输。MQTT 用于发现和信令，会话数据通过点对点链路传输。基于 [Pi coding agent SDK](https://github.com/earendil-works/pi-coding-agent) 驱动。

> 🚀 **[在线 Demo](https://pnchen.github.io/agentthere/demo/)**

## 快速开始

### 准备条件

- Node.js ≥ 18
- 一个 MQTT broker（[EMQX](https://www.emqx.io/)、[Mosquitto](https://mosquitto.org/) 等）
- Pi coding agent API key

### 1. 安装

```bash
cd pi-channel
npm install
```

### 2. 配置

创建 `~/.agentthere/agentthere.json`（或设置 `AGENTTHERE_HOME` 环境变量）：

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

#### 顶层字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `mqtt` | ✓ | MQTT broker 连接配置 |
| `ice_servers` |  | STUN/TURN 服务器（默认使用 Google STUN） |
| `agents` | ✓ | Agent 定义；键为配置别名 |
| `groups` | ✓ | 群组定义；键为群组名 |

#### Agent 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `model` | ✓ | 模型 ID，格式 `provider/model`（如 `deepseek/deepseek-chat`） |
| `workspace` |  | Agent 工作区目录（默认 `workspaces/<key>` 位于配置目录下） |
| `stt` |  | 语音识别配置，包含 `wss` 和 `api_key`（可选，用于语音） |
| `tts` |  | 语音合成配置，包含 `providers` 和 `personas`（可选，用于语音） |
| `skills` |  | 按 skill 配置环境变量 |
| `thinking_level` |  | 思考预算：`"off"`、`"minimal"`、`"low"`、`"medium"`、`"high"` |

#### 群组字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `agent` | ✓ | 绑定的 agent 配置键名 |

访问控制使用配置目录下的 `users.jsonl`（配对码授权机制）。

### 3. 启动服务

```bash
node pi-channel/service.js
```

### 4. 启动客户端

```bash
cd client
npm install
npm run dev
```

打开 `http://localhost:5173`，输入群组名，即可开始聊天。

生产构建：

```bash
cd client
npm run build
# 使用任意静态文件服务托管 `client/dist` 目录
```

## 架构

```text
浏览器（Vue 3 SPA）
    │
    │  MQTT 信令：发现 + SDP/ICE 交换
    ▼
Pi Channel Service（Node.js）
    │
    ├─ WebRTC DataChannel  → 文字聊天、`_patch` 流、文件
    └─ WebRTC MediaTrack   → Opus RTP 语音流
    │
Pi Coding Agent SDK
```

### 传输职责

- **MQTT** — 节点发现和信令
- **WebRTC DataChannel** — 聊天、流式 patch、文件传输
- **WebRTC MediaTrack** — 麦克风输入和 TTS 输出
- **DTLS** — 点对点加密

## 项目结构

```text
agentthere/
├── pi-channel/             # Node.js 通道服务
│   ├── service.js          # 入口
│   ├── src/
│   │   ├── agent.js        # Agent 会话管理
│   │   ├── config.js       # 单文件配置（JSON5）
│   │   ├── sdk-bridge.js   # Pi SDK ↔ 通道协议桥接
│   │   ├── channel/
│   │   │   ├── router/     # Koa 风格中间件路由
│   │   │   ├── middleware/ # intent、history、auth-gate
│   │   │   └── route/      # message、call 处理器
│   │   ├── rtc/            # WebRTC peer 连接 & VAD
│   │   └── tools/          # 自定义工具（文件传输、媒体）
├── client/                 # 浏览器 SPA（Vue 3 + Vite）
└── LICENSE
```

## 技术栈

| 层 | 技术 |
|---|---|
| 信令 | MQTT (WSS) |
| NAT 穿透 | STUN + TURN |
| 数据通道 | WebRTC DataChannel |
| 流式协议 | `_patch` JSON 操作 |
| 音频编码 | Opus RTP |
| 服务端 | Node.js + node-datachannel |
| Agent SDK | Pi coding agent |
| 客户端 | Vue 3 + Vite + WebRTC API |
| 语音 VAD | Silero ONNX |

## License

MIT © AgentThere
