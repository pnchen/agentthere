import { decodeOpus } from '../../route/call/opus-codec.js';

const PCM16_MAX = 32768;
const PCM48_SAMPLE_RATE = 48000;
const VAD_SAMPLE_RATE = 16000;

const RTC_VAD_DEFAULTS = Object.freeze({
    enabled: true,
    positiveSpeechThreshold: 0.62,
    negativeSpeechThreshold: 0.22,
    redemptionMs: 640,
    preSpeechPadMs: 280,
    minSpeechMs: 280,
    frameSamples: 1536
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
        const [{ createRequire }, path, fs] = await Promise.all([import('node:module'), import('node:path'), import('node:fs/promises')]);
        const require = createRequire(import.meta.url);
        const { FrameProcessor, Message, Resampler } = require('@ricky0123/vad-node');
        const { Silero } = require('@ricky0123/vad-node/dist/_common/models.js');
        const ort = require('onnxruntime-node');
        const vadEntryPath = require.resolve('@ricky0123/vad-node');
        const vadModelPath = path.join(path.dirname(vadEntryPath), 'silero_vad.onnx');

        return {
            FrameProcessor,
            Message,
            Resampler,
            Silero,
            ort,
            modelFetcher: async () => {
                const contents = await fs.readFile(vadModelPath);
                return contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength);
            }
        };
    })().catch(err => {
        _vadModulesPromise = null;
        throw err;
    });
    return _vadModulesPromise;
}

function isOpusRtpPacket(msg) {
    return Buffer.isBuffer(msg) && msg.length >= 2 && (msg[1] & 0x7f) === 111;
}

class VADAudioTrackHandle {
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
        return new Promise(resolve => {
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
                .then(vadState => {
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
        console.log(`[agentthere/rtc/vad] mode=${next ? 'passthrough' : 'filter'}`);
    }

    async _getVadState() {
        if (this._vadStatePromise) return this._vadStatePromise;
        this._vadStatePromise = this._createVadState().catch(err => {
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
            frame => silero.process(frame),
            () => silero.reset_state(),
            {
                positiveSpeechThreshold: this._rtcVad.positiveSpeechThreshold,
                negativeSpeechThreshold: this._rtcVad.negativeSpeechThreshold,
                redemptionFrames: msToFrameCount(this._rtcVad.redemptionMs, frameSamples),
                frameSamples,
                preSpeechPadFrames: msToFrameCount(this._rtcVad.preSpeechPadMs, frameSamples),
                minSpeechFrames: msToFrameCount(this._rtcVad.minSpeechMs, frameSamples),
                submitUserSpeechOnPause: false
            }
        );
        processor.resume();

        return {
            Message,
            processor,
            resampler: new Resampler({
                nativeSampleRate: PCM48_SAMPLE_RATE,
                targetSampleRate: VAD_SAMPLE_RATE,
                targetFrameSize: frameSamples
            }),
            minSpeechFrames: msToFrameCount(this._rtcVad.minSpeechMs, frameSamples)
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
        const packets = this._pendingPackets.map(entry => entry.msg);
        console.log(`[agentthere/rtc/vad] flushed pending packets=${packets.length}`);
        this._clearPendingPackets();
        return packets;
    }

    _openGate() {
        if (this._rtcVadGateOpen) return [];
        this._rtcVadGateOpen = true;
        console.log('[agentthere/rtc/vad] gate open');
        return this._flushPendingPackets();
    }

    _closeGate(reason) {
        if (this._rtcVadGateOpen) {
            console.log(`[agentthere/rtc/vad] gate close reason=${reason}`);
        }
        this._rtcVadGateOpen = false;
        this._clearPendingPackets();
    }

    _hasRealSpeech(vadState) {
        return vadState.processor.speaking && countSpeechFrames(vadState.processor.audioBuffer) >= vadState.minSpeechFrames;
    }

    async _processVadFrames(msg, pcm48) {
        const vadState = await this._getVadState();
        const frames = vadState.resampler.process(pcm16ToFloat32(pcm48));
        let openedThisTurn = false;

        for (const frame of frames) {
            const result = await vadState.processor.process(frame);
            if (!this._rtcVadGateOpen && this._hasRealSpeech(vadState)) {
                const pendingPackets = this._openGate();
                openedThisTurn = true;
                if (pendingPackets.length === 0) {
                    this._enqueue(msg);
                } else {
                    for (const pendingPacket of pendingPackets) {
                        this._enqueue(pendingPacket);
                    }
                }
            }
            // SpeechEnd / VADMisfire / SpeechStop are no longer used to
            // close the gate. Once the gate opens, it stays open so that
            // trailing silence reaches the STT service for proper
            // sentence finalization (like client-side VAD does with a
            // gain node that outputs zeros when gate is "closed").
        }

        if (this._rtcVadGateOpen && !openedThisTurn) {
            this._enqueue(msg);
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
            .catch(err => {
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

export { VADAudioTrackHandle };
