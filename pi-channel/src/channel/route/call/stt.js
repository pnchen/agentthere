/**
 * AgentThere STT — Qwen ASR realtime speech recognition.
 *
 * Adapted from /openclaw-plugin/stt/src/index.js for the standalone
 * pi-channel service. Removed the openclaw RealtimeVoiceProvider plugin
 * wrapper; this module directly exposes createStt({ config, onTranscript }).
 *
 * Expects config:
 *   { wss: "wss://...", api_key: "..." }
 *
 * Expects feedPcm() input at 16 kHz, mono, PCM16 little-endian.
 */

import { randomBytes } from "node:crypto";
import WebSocket from "ws";

const IDLE_MS = 8_000;
const PCM_BUFFER_MAX_FRAMES = 50; // ~1s at 20ms/frame

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

/**
 * Create an STT session.
 *
 * @param {object} opts
 * @param {{ wss: string, api_key: string }} opts.config
 * @param {(text: string, isFinal: boolean) => void} [opts.onTranscript]
 * @param {() => void} [opts.onSpeechStarted]
 * @param {(err: Error) => void} [opts.onError]
 */
export function createStt({ config, onTranscript, onSpeechStarted, onError }) {
    const sttConfig = config;
    if (!sttConfig?.wss || !sttConfig?.api_key) {
        throw new Error("STT config missing wss or api_key");
    }

    const inputRate = 16000;
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
            console.log(`[agentthere-stt] idle ${IDLE_MS}ms, closing ws (will reconnect on next audio)`);
            try {
                sttWs.close();
            }
            catch {
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
        while (pcmBuffer.length > 0 && _connected && sttWs?.readyState === WebSocket.OPEN) {
            const pcm = pcmBuffer.shift();
            const pcm16k = inputRate === 16000 ? pcm : resamplePcm16(pcm, inputRate, 16000);
            if (pcm16k.length === 0) continue;
            try {
                sendPcmToWs(sttWs, pcm16k);
            }
            catch (e) {
                console.log(`[agentthere-stt] flush error: ${e.message}`);
                break;
            }
        }
    }

    async function _openWs() {
        console.log(`[agentthere-stt] connecting to ${sttConfig.wss}`);

        const ws = new WebSocket(sttConfig.wss, {
            headers: { Authorization: `bearer ${sttConfig.api_key}` },
        });
        sttWs = ws;
        sentenceStarted = false;
        currentSentence = "";

        let handshakeResolve;
        let handshakeReject;
        const handshakeDone = new Promise((resolve, reject) => {
            handshakeResolve = resolve;
            handshakeReject = reject;
        });

        const handshakeTimer = setTimeout(() => {
            try {
                ws.close();
            }
            catch {
                /* ignore */
            }
            handshakeReject(new Error("STT connect timeout (waiting for session.updated)"));
        }, 15_000);

        ws.on("message", (raw) => {
            let data;
            try {
                data = JSON.parse(raw.toString());
            }
            catch {
                return;
            }
            const eventType = data.type;
            console.log(`[agentthere-stt] ← ${eventType}`);

            if (eventType === "error") {
                const errMsg = data.error?.message ?? data.message ?? "STT error";
                console.log(`[agentthere-stt] STT error: ${errMsg}`);
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
                    console.log("[agentthere-stt] bridge ready");
                    handshakeResolve();
                }
                return;
            }

            if (eventType === "input_audio_buffer.speech_started") {
                console.log("[agentthere-stt] speech started");
                onSpeechStarted?.();
                return;
            }

            if (eventType === "input_audio_buffer.speech_stopped") {
                console.log("[agentthere-stt] speech stopped");
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
                    const partial = emotionLabel(data.emotion) + (data.text ?? "") + (data.stash ?? "");
                    sentenceStarted = true;
                    currentSentence = partial;
                    console.log(`[agentthere-stt] partial: "${partial}"`);
                    onTranscript?.(partial, false);
                    break;
                }
                case "conversation.item.input_audio_transcription.completed": {
                    const finalText = emotionLabel(data.emotion) + (data.transcript ?? "");
                    sentenceStarted = false;
                    currentSentence = finalText;
                    console.log(`[agentthere-stt] final: "${finalText}"`);
                    onTranscript?.(finalText, true);
                    break;
                }
                case "session.finished":
                    console.log("[agentthere-stt] session finished");
                    break;
                default:
                    break;
            }
        });

        ws.on("error", (err) => {
            console.log(`[agentthere-stt] ws error: ${err.message}`);
            if (!_connected) {
                clearTimeout(handshakeTimer);
                handshakeReject(err);
            }
            else {
                onError?.(err);
            }
        });

        ws.on("close", (code, reason) => {
            const detail = reason?.toString() ?? "";
            console.log(`[agentthere-stt] ws closed: code=${code} ${detail}`);
            const wasConnected = _connected;
            if (!wasConnected) {
                clearTimeout(handshakeTimer);
                handshakeReject(new Error(`STT ws closed before ready: code=${code}`));
            }
            if (!_intentionallyClosed && sentenceStarted && currentSentence) {
                onTranscript?.(currentSentence, true);
                sentenceStarted = false;
                currentSentence = "";
            }
            if (sttWs === ws) {
                _connected = false;
                sttWs = null;
            }
        });

        ws.on("open", () => {
            console.log("[agentthere-stt] ws open, sending session.update…");
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
                            threshold: 0,
                            silence_duration_ms: 4000,
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
                console.log(`[agentthere-stt] reconnect failed: ${err.message}`);
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
            const pcm16k = inputRate === 16000 ? pcm : resamplePcm16(pcm, inputRate, 16000);
            if (pcm16k.length > 0) {
                try {
                    sendPcmToWs(sttWs, pcm16k);
                }
                catch (e) {
                    console.log(`[agentthere-stt] sendAudio error: ${e.message}`);
                }
            }
            armIdleTimer();
        }
        else {
            pushPcm(pcm);
            ensureConnected();
        }
    }

    async function _close() {
        _intentionallyClosed = true;
        _disposed = true;
        clearIdleTimer();
        pcmBuffer.length = 0;
        if (sttWs) {
            try {
                sttWs.close();
            }
            catch {
                /* ignore */
            }
            sttWs = null;
        }
        _connected = false;
    }

    // Start connect eagerly so the first feedPcm can send immediately.
    connect().catch((err) => {
        console.log(`[agentthere-stt] initial connect failed: ${err.message}`);
        onError?.(err);
    });

    return {
        feedPcm(pcm) {
            sendAudio(pcm);
        },
        close: _close,
    };
}
