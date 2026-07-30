/**
 * Voice audio track handle with VAD gating.
 *
 * Adapted from openclaw-plugin/channel/src/channel/rtc/peer/audio-gate.js
 * Import path adjusted for pi-channel layout.
 */

import { decodeOpus } from "../../routes/agent/call/opus-codec.js";
import fs from "node:fs";
import path from "node:path";

const PCM16_MAX = 32768;
const PCM48_SAMPLE_RATE = 48000;
const VAD_SAMPLE_RATE = 16000;

const RTC_VAD_DEFAULTS = Object.freeze({
    enabled: true,
    positiveSpeechThreshold: 0.70,
    negativeSpeechThreshold: 0.50,
    redemptionMs: 1200,
    preSpeechPadMs: 800,
    minSpeechMs: 600,
    openConfirmFrames: 8,
    openConfirmSpeechFrames: 7,
    frameSamples: 1536,
});

let _vadModulesPromise = null;

function pcm16ToFloat32(buf) {
    const sampleCount = Math.floor(buf.length / 2);
    const out = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
        out[i] = buf.readInt16LE(i * 2) / PCM16_MAX;
    }
    return out;
}

function msToFrameCount(ms, frameSamples) {
    const frameMs = (frameSamples / VAD_SAMPLE_RATE) * 1000;
    return Math.max(1, Math.ceil(ms / frameMs));
}

function countSpeechFrames(audioBuffer) {
    let total = 0;
    for (const item of audioBuffer) {
        if (item?.isSpeech) total += 1;
    }
    return total;
}

function getPendingWindowMs(rtcVad) {
    return Math.max(rtcVad.preSpeechPadMs, rtcVad.preSpeechPadMs + rtcVad.minSpeechMs);
}

async function loadVadModules() {
    if (_vadModulesPromise) return _vadModulesPromise;
    _vadModulesPromise = (async () => {
        const [{ createRequire }, path, fs] = await Promise.all([
            import("node:module"),
            import("node:path"),
            import("node:fs/promises"),
        ]);
        const require = createRequire(import.meta.url);
        const { FrameProcessor, Message, Resampler } = require("@ricky0123/vad-node");
        const { Silero } = require("@ricky0123/vad-node/dist/_common/models.js");
        const ort = require("onnxruntime-node");
        const vadEntryPath = require.resolve("@ricky0123/vad-node");
        const vadModelPath = path.join(path.dirname(vadEntryPath), "silero_vad.onnx");

        return {
            FrameProcessor,
            Message,
            Resampler,
            Silero,
            ort,
            modelFetcher: async () => {
                const contents = await fs.readFile(vadModelPath);
                return contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength);
            },
        };
    })().catch((err) => {
        _vadModulesPromise = null;
        throw err;
    });
    return _vadModulesPromise;
}

function isOpusRtpPacket(msg) {
    return Buffer.isBuffer(msg) && msg.length >= 2 && (msg[1] & 0x7f) === 111;
}

export class VADAudioTrackHandle {
    constructor({ rtcVad = RTC_VAD_DEFAULTS, passthrough = false } = {}) {
        this._queue = [];
        this._closed = false;
        this._waiters = [];
        this._rtcVad = { ...RTC_VAD_DEFAULTS, ...rtcVad, enabled: true };
        this._rtcVadGateOpen = false;
        this._processing = Promise.resolve();
        this._pendingPackets = [];
        this._vadStatePromise = null;
        this._passthrough = passthrough === true;
        this._drainUntil = null;
        console.log(`[agentthere/rtc/vad] mode=${this._passthrough ? "passthrough" : "filter"}`);
    }

    _enqueue(msg) {
        if (this._closed) return;
        const waiter = this._waiters.shift();
        if (waiter) waiter.resolve({ value: msg, done: false });
        else this._queue.push(msg);
    }

    async next() {
        if (this._queue.length > 0) {
            return { value: this._queue.shift(), done: false };
        }
        if (this._closed) return { done: true };
        return new Promise((resolve) => {
            this._waiters.push({ resolve });
        });
    }

    [Symbol.asyncIterator]() {
        return { next: () => this.next() };
    }

    _resetFilterState() {
        this._rtcVadGateOpen = false;
        this._clearPendingPackets();
        if (this._vadStatePromise) {
            void this._vadStatePromise
                .then((vadState) => {
                    vadState.processor.reset();
                })
                .catch(() => {
                    /* ignore */
                });
        }
    }

    setPassthrough(passthrough) {
        const next = passthrough === true;
        if (this._passthrough === next) return;
        this._passthrough = next;
        this._resetFilterState();
        console.log(`[agentthere/rtc/vad] mode=${next ? "passthrough" : "filter"}`);
    }

    async _getVadState() {
        if (this._vadStatePromise) return this._vadStatePromise;
        this._vadStatePromise = this._createVadState().catch((err) => {
            this._vadStatePromise = null;
            throw err;
        });
        return this._vadStatePromise;
    }

    async _createVadState() {
        const { FrameProcessor, Message, Resampler, Silero, ort, modelFetcher } = await loadVadModules();
        const silero = await Silero.new(ort, modelFetcher);
        const frameSamples = this._rtcVad.frameSamples;
        const processor = new FrameProcessor(
            (frame) => silero.process(frame),
            () => silero.reset_state(),
            {
                positiveSpeechThreshold: this._rtcVad.positiveSpeechThreshold,
                negativeSpeechThreshold: this._rtcVad.negativeSpeechThreshold,
                redemptionFrames: msToFrameCount(this._rtcVad.redemptionMs, frameSamples),
                frameSamples,
                preSpeechPadFrames: msToFrameCount(this._rtcVad.preSpeechPadMs, frameSamples),
                minSpeechFrames: msToFrameCount(this._rtcVad.minSpeechMs, frameSamples),
                submitUserSpeechOnPause: false,
            }
        );
        processor.resume();

        return {
            Message,
            processor,
            resampler: new Resampler({
                nativeSampleRate: PCM48_SAMPLE_RATE,
                targetSampleRate: VAD_SAMPLE_RATE,
                targetFrameSize: frameSamples,
            }),
            minSpeechFrames: msToFrameCount(this._rtcVad.minSpeechMs, frameSamples),
        };
    }

    _clearPendingPackets() {
        this._pendingPackets.length = 0;
    }

    _pushPendingPacket(msg, now) {
        if (this._rtcVadGateOpen) return;
        this._pendingPackets.push({ msg: Buffer.from(msg), at: now });
        const pendingWindowMs = getPendingWindowMs(this._rtcVad);
        while (this._pendingPackets.length > 0 && now - this._pendingPackets[0].at > pendingWindowMs) {
            this._pendingPackets.shift();
        }
    }

    _flushPendingPackets() {
        if (this._pendingPackets.length === 0) return [];
        const packets = this._pendingPackets.map((entry) => entry.msg);
        console.log(`[agentthere/rtc/vad] flushed pending packets=${packets.length}`);
        this._clearPendingPackets();
        return packets;
    }

    _openGate(vadState) {
        if (this._rtcVadGateOpen) return [];
        const recentFrames = vadState.processor.audioBuffer.slice(-this._rtcVad.openConfirmFrames);
        const speechFrames = countSpeechFrames(recentFrames);
        this._rtcVadGateOpen = true;
        console.log(`[agentthere/rtc/vad] gate open speechFrames=${speechFrames}/${recentFrames.length} threshold=${this._rtcVad.positiveSpeechThreshold}`);
        // this._dumpTrigger(); // TODO: fix per-packet decode
        return this._flushPendingPackets();
    }

    _dumpTrigger() {
        try {
            const dir = "./vad-triggers";
            fs.mkdirSync(dir, { recursive: true });
            const ts = new Date().toISOString().replace(/[:.]/g, "-");
            const filepath = path.join(dir, `trigger-${ts}.opus`);
            const parts = [];
            for (const { msg } of this._pendingPackets) parts.push(msg);
            if (this._triggerMsg) parts.push(this._triggerMsg);
            const merged = Buffer.concat(parts);
            fs.writeFileSync(filepath, merged);
            (async () => {
                try {
                    const pcmChunks = [];
                    for (const pkt of parts) {
                        const pcm = await decodeOpus(pkt);
                        if (pcm) pcmChunks.push(pcm);
                    }
                    if (pcmChunks.length === 0) return console.log(`[agentthere/rtc/vad] dump: decode all failed`);
                    const pcm48 = Buffer.concat(pcmChunks);
                    const samples = pcm48.length / 2;
                    const durationMs = Math.round((samples / PCM48_SAMPLE_RATE) * 1000);
                    let sumSq = 0, peak = 0;
                    for (let i = 0; i < samples; i++) {
                        const v = pcm48.readInt16LE(i * 2);
                        sumSq += v * v;
                        if (Math.abs(v) > peak) peak = Math.abs(v);
                    }
                    const rms = Math.round(Math.sqrt(sumSq / samples));
                    const peakDb = Math.round(20 * Math.log10((peak || 1) / PCM16_MAX));
                    console.log(`[agentthere/rtc/vad] dump: ${durationMs}ms peak=${peakDb}dB rms=${rms} packets=${parts.length} size=${merged.length} -> ${filepath}`);
                } catch { /* ignore */ }
            })();
        } catch (err) {
            console.warn(`[agentthere/rtc/vad] dump failed: ${String(err)}`);
        }
    }

    _closeGate(reason) {
        if (this._rtcVadGateOpen) {
            console.log(`[agentthere/rtc/vad] gate close reason=${reason}`);
        }
        this._rtcVadGateOpen = false;
        this._clearPendingPackets();
    }

    _hasRealSpeech(vadState) {
        const recentFrames = vadState.processor.audioBuffer.slice(-this._rtcVad.openConfirmFrames);
        return vadState.processor.speaking
            && recentFrames.length >= this._rtcVad.openConfirmFrames
            && countSpeechFrames(recentFrames) >= this._rtcVad.openConfirmSpeechFrames;
    }

    async _processVadFrames(msg, pcm48) {
        const vadState = await this._getVadState();
        const frames = vadState.resampler.process(pcm16ToFloat32(pcm48));
        let openedThisTurn = false;

        for (const frame of frames) {
            const result = await vadState.processor.process(frame);
            if (result.msg) {
                const g = this._rtcVadGateOpen;
                console.log(`[agentthere/rtc/vad] frame msg=${result.msg} gate=${g ? "open" : "closed"} speaking=${vadState.processor.speaking}`);
                if (g && result.msg === "SPEECH_END") {
                    this._drainUntil = Date.now() + 3000;
                    console.log(`[agentthere/rtc/vad] drain started`);
                }
                else if (result.msg === "SPEECH_START") {
                    this._drainUntil = null;
                }
            }
            if (!this._rtcVadGateOpen && this._hasRealSpeech(vadState)) {
                // this._triggerMsg = msg;
                const pendingPackets = this._openGate(vadState);
                openedThisTurn = true;
                if (pendingPackets.length === 0) {
                    this._enqueue(msg);
                }
                else {
                    for (const pendingPacket of pendingPackets) {
                        this._enqueue(pendingPacket);
                    }
                }
            }
        }

        if (this._rtcVadGateOpen && !openedThisTurn) {
            this._enqueue(msg);
        }
        if (this._drainUntil && Date.now() >= this._drainUntil) {
            this._closeGate("drain");
            this._drainUntil = null;
        }
    }

    async _processMessage(msg) {
        if (this._closed) return;
        if (!this._rtcVad.enabled || this._passthrough || !isOpusRtpPacket(msg)) {
            this._enqueue(msg);
            return;
        }

        const now = Date.now();
        this._pushPendingPacket(msg, now);

        const pcm48 = await decodeOpus(msg);
        if (!pcm48) {
            if (this._rtcVadGateOpen) {
                this._enqueue(msg);
            }
            return;
        }

        await this._processVadFrames(msg, pcm48);
    }

    push(msg) {
        if (this._closed) return;
        this._processing = this._processing
            .then(() => this._processMessage(msg))
            .catch((err) => {
                console.error(`[agentthere/rtc/vad] processing failed: ${String(err)}`);
                this._enqueue(msg);
            });
    }

    close() {
        if (this._closed) return;
        this._resetFilterState();
        this._closed = true;
        for (const waiter of this._waiters) waiter.resolve({ done: true });
        this._waiters = [];
        this._queue = [];
    }
}
