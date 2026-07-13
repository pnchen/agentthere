# AgentThere

> OpenClaw 的 WebRTC 直连通道，用于与 AI agent 实时协作。

[English](README.md) | 中文

AgentThere 通过 WebRTC 连接浏览器与运行在本地电脑上的 OpenClaw AI agent，支持低延迟的文本、语音和文件传输。MQTT 用于发现和信令，会话数据都通过点对点链路传输。

> 🚀 **[在线 Demo](https://pnchen.github.io/agentthere/demo/)**

## 为什么选择 AgentThere

- **探索式小团队协作**：一个共享实时工作区，少量用户和 OpenClaw agent 可以一起头脑风暴、试验和迭代
- **文本、语音和文件一体化**：聊天、通话和文件传输都在同一个会话里完成
- **本地优先部署**：OpenClaw 运行在你自己的电脑上，不依赖公共服务器
- **接入可控**：通过 OpenClaw 的配对授权机制加入

## 快速开始

### 准备条件

- 已在本地电脑启动的 [OpenClaw Gateway](https://docs.openclaw.ai/start/getting-started)
- 一个 MQTT broker，例如 [EMQX](https://www.emqx.io/) 或 [Mosquitto](https://mosquitto.org/)

### 1. 安装插件

```bash
cd openclaw-plugin/channel
npm install
cd ../..
openclaw plugins install --link ./openclaw-plugin/channel
```

### 2. 配置 `~/.openclaw/openclaw.json`

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

#### 通道配置

| 字段 | 必填 | 类型 | 说明 |
|------|:--:|------|------|
| `enabled` | ✓ | boolean | 启用通道 |
| `mqtt.url` | ✓ | string | MQTT broker 地址（`wss://`） |
| `mqtt.namespace` |  | string | 主题前缀，用于隔离多套部署；两端必须一致 |
| `mqtt.username` |  | string | MQTT 用户名 |
| `mqtt.password` |  | string | MQTT 密码 |
| `dmPolicy` |  | string | 默认 `pairing`；控制新 peer 的接入方式 |
| `iceServers` |  | array | STUN/TURN 服务器列表 |
| `allowFrom` |  | array | 允许列表（peer UID） |
| `groups` | ✓ | object | 群组配置；键为群组名 |

#### 群组配置

| 字段 | 说明 |
|------|------|
| `openclaw_agent_id` | 绑定指定 agent |
| `systemPrompt` | 群组级提示词 |
| `skills` | 限制可用技能列表 |
| `verbose` | 设置为 `"on"` 时，客户端展示工具调用细节 |

### 3. 启动客户端

```bash
cd client
npm install
npm run dev
```

打开 `http://localhost:5173`，输入群组名，即可开始聊天。

生产构建：

```bash
npm run build
# 使用任意静态文件服务托管 `client/dist` 目录
```

### 可选：安装 STT 插件

语音默认走 OpenClaw Voice Realtime；如果你想接入阿里云 ASR，可以安装 STT 插件：

```bash
cd openclaw-plugin/stt
npm install
cd ../..
openclaw plugins install --link ./openclaw-plugin/stt
```

## 工作原理

```text
浏览器（Vue 3 SPA）
    │
    │  MQTT 信令：用于发现和 SDP/ICE 交换
    ▼
AgentThere 插件（node-datachannel）
    │
    ├─ WebRTC DataChannel  → 文字聊天、`_patch` 流、文件
    └─ WebRTC MediaTrack   → Opus RTP 语音流

OpenClaw Gateway / AI Agent Loop
```

### 传输职责

- **MQTT**：用于节点发现和信令
- **WebRTC DataChannel**：承载聊天消息、流式 `_patch`、文件元数据和文件分块
- **WebRTC MediaTrack**：承载麦克风输入和 TTS 输出
- **DTLS**：用于点对点流量加密

## 可以基于它做什么

- **探索式小团队协作**：一个共享实时工作区，少量用户和 OpenClaw agent 可以一起头脑风暴、试验和迭代
- 语音优先的 agent 界面
- 支持文件处理的助手工作流
- 移动端或桌面端 WebRTC 客户端
- 使用同一通道协议的轻量级嵌入式客户端

当前浏览器客户端是参考实现，同一通道也可扩展到其他 WebRTC 前端。

## 项目结构

```text
agentthere/
├── openclaw-plugin/
│   ├── channel/            # AgentThere channel plugin
│   └── stt/                # 可选 STT 插件
├── client/                 # 浏览器 SPA（Vue 3 + Vite）
├── docs/
│   ├── SPEC.en.md          # 英文版协议说明
│   └── SPEC.zh.md          # 中文版协议说明
└── LICENSE
```

## 技术栈

| 层 | 技术 |
|---|---|
| 信令 | MQTT (WSS) |
| NAT 穿透 | STUN + TURN |
| 数据通道 | WebRTC DataChannel |
| 流式协议 | `_patch` JSON ops |
| 音频编码 | Opus RTP |
| Gateway | Node.js + node-datachannel |
| 客户端 | Vue 3 + Vite + WebRTC API |
| 语音 VAD | Silero ONNX |
| 存储 | IndexedDB |

## 文档

- [SPEC.zh.md](docs/SPEC.zh.md) — 协议说明：MQTT 主题、DataChannel 消息格式、`_patch` 操作和文件传输

## License

MIT © AgentThere
