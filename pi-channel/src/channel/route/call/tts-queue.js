/**
 * Per-peer HTTP TTS pipeline.
 *
 * Text is normalized and sentence-chunked incrementally. Synthesis is limited
 * to one HTTP request at a time, while the next sentence may be synthesized
 * ahead of playback so sentence boundaries do not introduce avoidable gaps.
 */

import { synthesizeOpenAiSpeech } from './openai-tts.js';
import { SpeechTextPipeline } from './speech-text.js';
import { decodeTtsAudioToPcm16 } from './audio-decode.js';

const TTS_FLUSH = Symbol('tts-flush');
const _queues = new Map(); // peerId -> TtsTextQueue

class TtsTextQueue {
    constructor() {
        this._inputQueue = [];
        this._textQueue = [];
        this._closed = false;
        this._waiters = [];
        this._cancelEpoch = 0;
        this._speechPipeline = new SpeechTextPipeline();
        this._synthesisRunning = false;
        this._synthesisAbort = null;
        this._readyAudio = null;
        this._readyText = null;
        this._playing = false;
        this._pumpScheduled = false;
        this._opts = null;
        this._peerId = null;
    }

    push(msg) {
        if (this._closed) return;
        const waiter = this._waiters.shift();
        if (waiter) waiter.resolve({ value: msg, done: false });
        else this._inputQueue.push(msg);
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        this._synthesisAbort?.abort();
        for (const waiter of this._waiters) waiter.resolve({ done: true });
        this._waiters = [];
        this._inputQueue = [];
        this._textQueue = [];
    }

    clear() {
        this._inputQueue = [];
        this._textQueue = [];
        this._speechPipeline.reset();
        this._readyAudio = null;
        this._readyText = null;
    }

    async next() {
        if (this._inputQueue.length > 0) {
            return { value: this._inputQueue.shift(), done: false };
        }
        if (this._closed) return { done: true };
        return new Promise((resolve) => this._waiters.push({ resolve }));
    }

    [Symbol.asyncIterator]() {
        return { next: () => this.next() };
    }

    bumpCancelEpoch() {
        this._cancelEpoch += 1;
        return this._cancelEpoch;
    }

    getCancelEpoch() {
        return this._cancelEpoch;
    }

    writeText(chunk) {
        return this._speechPipeline.push(chunk);
    }

    flushText() {
        return this._speechPipeline.flush();
    }

    resetText() {
        this._speechPipeline.reset();
    }

    attachRuntime(peerId, opts) {
        this._peerId = peerId;
        this._opts = opts;
    }

    enqueueText(text) {
        if (!text) return;
        this._textQueue.push(text);
        this._schedulePump();
    }

    _schedulePump() {
        if (this._pumpScheduled) return;
        this._pumpScheduled = true;
        setImmediate(() => {
            this._pumpScheduled = false;
            this._pump().catch((err) => {
                console.error(`[tts] pump error for ${this._peerId}: ${String(err)}`);
            });
        });
    }

    async _pump() {
        if (this._closed || !this._opts) return;

        // Start a ready sentence immediately, without waiting for playback to
        // finish. _play() owns the playback lifetime and schedules another
        // pump when it ends.
        if (!this._playing && this._readyAudio) {
            const ready = this._readyAudio;
            const readyText = this._readyText;
            this._readyAudio = null;
            this._readyText = null;
            void this._play(ready, readyText);
        }

        // One HTTP request at a time. While a sentence is playing, this is
        // the single next-sentence prefetch. No second audio result is kept.
        if (this._synthesisRunning || this._readyAudio || !this._textQueue.length) return;
        const text = this._textQueue.shift();
        await this._synthesize(text);
        this._schedulePump();
    }

    async _synthesize(text) {
        const opts = this._opts;
        const peerId = this._peerId;
        const epoch = this._cancelEpoch;
        const controller = new AbortController();
        this._synthesisAbort = controller;
        this._synthesisRunning = true;
        opts.onBusyChange?.(1);
        opts.onCancelIdle?.();

        try {
            const result = await synthesizeOpenAiSpeech({
                text,
                config: opts.ttsConfig,
                signal: controller.signal,
            });
            if (epoch !== this._cancelEpoch || controller.signal.aborted) return;
            if (!result?.success || !result.audioBuffer) {
                opts.onError?.(`TTS synthesis failed: ${result?.error ?? 'no audio'}`);
                return;
            }

            const pcm = await decodeTtsAudioToPcm16(result.audioBuffer, result.outputFormat);
            if (!pcm || pcm.length === 0 || epoch !== this._cancelEpoch || controller.signal.aborted) return;

            // If playback is currently active, retain exactly one next result.
            // This should normally be the next sentence because synthesis is
            // started only after the current sentence begins playing.
            if (this._playing) {
                if (this._readyAudio) {
                    // A second ready result should not normally occur because
                    // synthesis is single-flight. Keep the oldest result to
                    // preserve sentence order if an external callback races.
                    return;
                }
                this._readyAudio = pcm;
                this._readyText = text;
                this._schedulePump();
            }
            else {
                void this._play(pcm, text);
            }
        }
        catch (err) {
            if (!controller.signal.aborted) {
                console.error(`[tts] synth error for ${peerId}: ${String(err)}`);
                opts.onError?.(`TTS synthesis failed: ${String(err)}`);
            }
        }
        finally {
            if (this._synthesisAbort === controller) this._synthesisAbort = null;
            this._synthesisRunning = false;
            opts.onBusyChange?.(-1);
        }
    }

    async _play(pcm, text) {
        if (this._closed) return;
        this._playing = true;
        const playEpoch = this._cancelEpoch;
        this._opts.onResume?.();
        try {
            if (this._cancelEpoch !== playEpoch) return;
            await this._opts.onPcm(pcm);
            console.log(`[tts] sent peerId=${this._peerId} text="${text}" frames=${Math.floor(pcm.length / 1920)}`);
        }
        catch (err) {
            console.error(`[tts] playback error for ${this._peerId}: ${String(err)}`);
            this._opts.onError?.(`TTS playback failed: ${String(err)}`);
        }
        finally {
            this._playing = false;
            this._schedulePump();
        }
    }
}

function _startConsumer(peerId, opts) {
    const queue = _queues.get(peerId);
    if (!queue) return;
    queue.attachRuntime(peerId, opts);

    (async () => {
        for await (const msg of queue) {
            if (msg === TTS_FLUSH) {
                for (const text of queue.flushText()) queue.enqueueText(text);
                continue;
            }
            for (const text of queue.writeText(msg)) queue.enqueueText(text);
        }
        for (const text of queue.flushText()) queue.enqueueText(text);
        queue._synthesisAbort?.abort();
        _queues.delete(peerId);
    })().catch((err) => {
        console.error(`[tts] consumer error for ${peerId}: ${String(err)}`);
    });
}

export function ensureTtsConsumer(peerId, opts) {
    if (!opts?.ttsConfig || opts.ttsConfig.enabled === false) return;
    if (_queues.has(peerId)) {
        _queues.get(peerId).push(TTS_FLUSH);
        return;
    }
    const queue = new TtsTextQueue();
    _queues.set(peerId, queue);
    _startConsumer(peerId, opts);
}

export function pushTtsDelta(peerId, delta) {
    _queues.get(peerId)?.push(delta);
}

export function pushTtsFlush(peerId) {
    _queues.get(peerId)?.push(TTS_FLUSH);
}

export function closeTtsQueue(peerId) {
    const queue = _queues.get(peerId);
    queue?.close();
    queue?.resetText();
}

export function cancelTtsQueue(peerId, onStop) {
    const queue = _queues.get(peerId);
    onStop?.();
    if (!queue) return;
    queue.bumpCancelEpoch();
    queue._synthesisAbort?.abort();
    queue.clear();
}

export { TTS_FLUSH };
