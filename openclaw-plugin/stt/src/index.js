/**
 * AgentThere STT — Qwen ASR realtime speech recognition (standalone plugin).
 *
 * Implements RealtimeVoiceProviderPlugin + RealtimeVoiceBridge inline.
 *
 * Lifecycle:
 *   - Channel layer creates the bridge once and calls connect() once.
 *   - After that the bridge self-heals: when audio stops arriving for
 *     IDLE_MS, the WS is proactively closed (DashScope gateway kicks idle
 *     sessions at ~10s; we close at 8s to stay ahead). The next sendAudio
 *     transparently reconnects. PCM that arrives during reconnect lands
 *     in a small ring buffer and is flushed once the WS is ready, so the
 *     start of a new utterance is not lost.
 *   - onClose is only invoked when the channel layer calls close() —
 *     idle close and unexpected ws drops are internal events.
 *
 * Config (independent plugin):
 *   plugins.installs["agentthere-stt"].config = { wss: "...", api_key: "..." }
 *
 * Legacy config (still supported):
 *   channels.agentthere.stt = { wss: "...", api_key: "..." }
 */

import { randomBytes } from "node:crypto";
import WebSocket from "ws";

const PROVIDER_ID = "agentthere-stt";
const PROVIDER_LABEL = "AgentThere STT (Qwen ASR)";
const IDLE_MS = 8_000;
const PCM_BUFFER_MAX_FRAMES = 50; // ~1s at 20ms/frame

/**
 * Resolve STT config from talk.realtime.providers["agentthere-stt"].
 */
function resolveSttConfig(ctx) {
  const raw = ctx.rawConfig;
  if (raw?.wss && raw?.api_key) {
    return { wss: raw.wss, api_key: raw.api_key };
  }
  return null;
}

function hexId(len = 32) {
  return randomBytes(len / 2).toString("hex");
}

function resamplePcm16(input, inputRate, outputRate) {
  const ratio = inputRate / outputRate;
  const inSamples = input.length / 2;
  const outSamples = Math.floor(inSamples / ratio);
  if (outSamples === 0) return Buffer.alloc(0);
  const output = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    const srcIdx = Math.floor(i * ratio) * 2;
    output.writeInt16LE(input.readInt16LE(srcIdx), i * 2);
  }
  return output;
}

function createVoiceBridge({
  audioFormat,
  sttConfig,
  onTranscript,
  onError,
  onClose,
  onReady,
}) {
  const inputRate = audioFormat?.sampleRateHz ?? 24000;
  let sttWs = null;
  let _connected = false;
  let _intentionallyClosed = false;
  let _disposed = false;
  let sentenceStarted = false;
  let currentSentence = "";
  let idleTimer = null;
  let pendingConnect = null;
  const pcmBuffer = [];

  function clearIdleTimer() {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function armIdleTimer() {
    clearIdleTimer();
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (_disposed || !sttWs) return;
      console.log(
        `[agentthere-realtime-voice-provider] idle ${IDLE_MS}ms, closing ws (will reconnect on next audio)`,
      );
      try {
        sttWs.close();
      } catch {
        /* ignore */
      }
    }, IDLE_MS);
  }

  function pushPcm(pcm) {
    pcmBuffer.push(pcm);
    while (pcmBuffer.length > PCM_BUFFER_MAX_FRAMES) {
      pcmBuffer.shift();
    }
  }

  function sendPcmToWs(ws, pcm16k) {
    if (pcm16k.length === 0) return;
    const b64 = pcm16k.toString("base64");
    ws.send(
      JSON.stringify({
        event_id: hexId(),
        type: "input_audio_buffer.append",
        audio: b64,
      }),
    );
  }

  function flushPcmBuffer() {
    while (
      pcmBuffer.length > 0 &&
      _connected &&
      sttWs?.readyState === WebSocket.OPEN
    ) {
      const pcm = pcmBuffer.shift();
      const pcm16k =
        inputRate === 16000 ? pcm : resamplePcm16(pcm, inputRate, 16000);
      if (pcm16k.length === 0) continue;
      try {
        sendPcmToWs(sttWs, pcm16k);
      } catch (e) {
        console.log(
          `[agentthere-realtime-voice-provider] flush error: ${e.message}`,
        );
        break;
      }
    }
  }

  async function _openWs() {
    console.log(
      `[agentthere-realtime-voice-provider] connecting to ${sttConfig.wss}`,
    );

    const ws = new WebSocket(sttConfig.wss, {
      headers: { Authorization: `bearer ${sttConfig.api_key}` },
    });
    sttWs = ws;
    sentenceStarted = false;
    currentSentence = "";

    let handshakeResolve, handshakeReject;
    const handshakeDone = new Promise((resolve, reject) => {
      handshakeResolve = resolve;
      handshakeReject = reject;
    });

    const handshakeTimer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      handshakeReject(
        new Error("STT connect timeout (waiting for session.updated)"),
      );
    }, 15_000);

    ws.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const eventType = data.type;
      console.log(`[agentthere-realtime-voice-provider] ← ${eventType}`);

      if (eventType === "error") {
        const errMsg = data.error?.message ?? data.message ?? "STT error";
        console.log(
          `[agentthere-realtime-voice-provider] STT error: ${errMsg}`,
        );
        if (!_connected) {
          clearTimeout(handshakeTimer);
          handshakeReject(new Error(errMsg));
        }
        return;
      }

      if (eventType === "session.updated") {
        if (!_connected) {
          clearTimeout(handshakeTimer);
          _connected = true;
          onReady?.();
          console.log("[agentthere-realtime-voice-provider] bridge ready");
          handshakeResolve();
        }
        return;
      }

      if (eventType === "input_audio_buffer.speech_started") {
        console.log("[agentthere-realtime-voice-provider] speech started");
        return;
      }

      if (eventType === "input_audio_buffer.speech_stopped") {
        console.log("[agentthere-realtime-voice-provider] speech stopped");
        return;
      }

      function emotionLabel(emotion) {
        const map = {
          surprised: "😲",
          neutral: "",
          happy: "😊",
          sad: "😢",
          disgusted: "😖",
          angry: "😡",
          fearful: "😨",
        };
        return map[emotion] ?? "";
      }

      switch (eventType) {
        case "conversation.item.input_audio_transcription.text": {
          const partial =
            emotionLabel(data.emotion) + (data.text ?? "") + (data.stash ?? "");
          sentenceStarted = true;
          currentSentence = partial;
          console.log(
            `[agentthere-realtime-voice-provider] partial: "${partial}"`,
          );
          onTranscript?.("user", partial, false);
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          const finalText =
            emotionLabel(data.emotion) + (data.transcript ?? "");
          sentenceStarted = false;
          currentSentence = finalText;
          console.log(
            `[agentthere-realtime-voice-provider] final: "${finalText}"`,
          );
          onTranscript?.("user", finalText, true);
          break;
        }
        case "session.finished":
          console.log("[agentthere-realtime-voice-provider] session finished");
          break;
      }
    });

    ws.on("error", (err) => {
      console.log(
        `[agentthere-realtime-voice-provider] ws error: ${err.message}`,
      );
      if (!_connected) {
        clearTimeout(handshakeTimer);
        handshakeReject(err);
      } else {
        onError?.(err);
      }
    });

    ws.on("close", (code, reason) => {
      const detail = reason?.toString() ?? "";
      console.log(
        `[agentthere-realtime-voice-provider] ws closed: code=${code} ${detail}`,
      );
      const wasConnected = _connected;
      if (!wasConnected) {
        clearTimeout(handshakeTimer);
        handshakeReject(new Error(`STT ws closed before ready: code=${code}`));
      }
      // Only fire partial transcript on unexpected close. Intentional
      // close happens during session teardown — the session is already
      // deleted by the time this event fires.
      if (!_intentionallyClosed && sentenceStarted && currentSentence) {
        onTranscript?.("user", currentSentence, true);
        sentenceStarted = false;
        currentSentence = "";
      }
      if (sttWs === ws) {
        _connected = false;
        sttWs = null;
      }
      if (_intentionallyClosed) {
        onClose?.({ code: "stt-closed", reason: `intentional code=${code}` });
      }
    });

    ws.on("open", () => {
      console.log(
        "[agentthere-realtime-voice-provider] ws open, sending session.update…",
      );
      ws.send(
        JSON.stringify({
          event_id: hexId(),
          type: "session.update",
          session: {
            input_audio_format: "pcm",
            sample_rate: 16000,
            input_audio_transcription: { language: "zh" },
            turn_detection: {
              type: "server_vad",
              threshold: _vadParams.threshold,
              silence_duration_ms: _vadParams.silenceDurationMs,
            },
          },
        }),
      );
    });

    await handshakeDone;
  }

  function ensureConnected() {
    if (_disposed) return null;
    if (_connected && sttWs?.readyState === WebSocket.OPEN) return null;
    if (pendingConnect) return pendingConnect;
    pendingConnect = _openWs()
      .then(() => {
        flushPcmBuffer();
        armIdleTimer();
      })
      .catch((err) => {
        console.log(
          `[agentthere-realtime-voice-provider] reconnect failed: ${err.message}`,
        );
        onError?.(err);
      })
      .finally(() => {
        pendingConnect = null;
      });
    return pendingConnect;
  }

  async function connect() {
    await _openWs();
    armIdleTimer();
  }

  function sendAudio(pcm) {
    if (_disposed) return;
    if (_connected && sttWs?.readyState === WebSocket.OPEN) {
      const pcm16k =
        inputRate === 16000 ? pcm : resamplePcm16(pcm, inputRate, 16000);
      if (pcm16k.length > 0) {
        try {
          sendPcmToWs(sttWs, pcm16k);
        } catch (e) {
          console.log(
            `[agentthere-realtime-voice-provider] sendAudio error: ${e.message}`,
          );
        }
      }
      armIdleTimer();
    } else {
      pushPcm(pcm);
      ensureConnected();
    }
  }

  function close() {
    _intentionallyClosed = true;
    _disposed = true;
    clearIdleTimer();
    pcmBuffer.length = 0;
    if (sttWs) {
      try {
        sttWs.close();
      } catch {
        /* ignore */
      }
      sttWs = null;
    }
    _connected = false;
  }

  function isConnected() {
    return _connected && sttWs?.readyState === WebSocket.OPEN;
  }

  const _vadParams = { threshold: 0, silenceDurationMs: 4000 };

  function updateVad(updates) {
    if (updates.silenceDurationMs != null)
      _vadParams.silenceDurationMs = updates.silenceDurationMs;
    if (updates.threshold != null) _vadParams.threshold = updates.threshold;
    if (sttWs?.readyState === WebSocket.OPEN) {
      console.log(
        `[agentthere-realtime-voice-provider] updateVad: threshold=${_vadParams.threshold} silence=${_vadParams.silenceDurationMs}ms`,
      );
      sttWs.send(
        JSON.stringify({
          event_id: hexId(),
          type: "session.update",
          session: {
            turn_detection: {
              type: "server_vad",
              threshold: _vadParams.threshold,
              silence_duration_ms: _vadParams.silenceDurationMs,
            },
          },
        }),
      );
    }
  }

  return {
    connect,
    sendAudio,
    close,
    isConnected,
    updateVad,
    submitToolResult(_callId, _result, _options) {},
    acknowledgeMark() {},
    setMediaTimestamp(_ts) {},
  };
}

// ── RealtimeVoiceProviderPlugin ─────────────────────────────────────────────

export function buildRealtimeVoiceProvider() {
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    defaultModel: "agentthere-stt-default",
    autoSelectOrder: 1,

    capabilities: {
      transports: ["provider-websocket"],
      inputAudioFormats: ["pcm16_24khz"],
      outputAudioFormats: [],
    },

    resolveConfig(ctx) {
      return resolveSttConfig(ctx) ?? {};
    },

    isConfigured(ctx) {
      const c = ctx.providerConfig;
      return !!(c?.wss && c?.api_key);
    },

    createBridge(req) {
      const sttConfig = req.providerConfig;
      if (!sttConfig?.wss || !sttConfig?.api_key)
        throw new Error("AgentThere STT not configured");
      return createVoiceBridge({
        audioFormat: req.audioFormat,
        sttConfig,
        onTranscript: req.onTranscript,
        onError: req.onError,
        onClose: req.onClose,
        onReady: req.onReady,
      });
    },
  };
}
