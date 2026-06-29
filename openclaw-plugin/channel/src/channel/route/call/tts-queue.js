/**
 * Per-peer TTS pipeline — text queue, sentence buffering, synthesis,
 * and audio decode.  Callbacks to the channel layer play the final PCM.
 */

import removeMd from 'remove-markdown';
import { parseTtsDirectives } from 'openclaw/plugin-sdk/speech';
import { synthesizeSpeech, getTtsProvider, resolveTtsConfig, resolveTtsPrefsPath } from 'openclaw/plugin-sdk/tts-runtime';
import { decodeTtsAudioToPcm16 } from './audio-decode.js';

const TTS_FLUSH = Symbol('tts-flush');
const MAX_CHUNK = 60; // flush accumulated text when it exceeds this length without delimiter (auto mode)
const VOICE_FIRST = 15; // voice mode: emit first chunk after this many chars
const VOICE_NEXT = 40; // voice mode: emit subsequent chunks after this many chars (or delimiter)

// ── async iterable queue ──────────────────────────────────────────

class TtsTextQueue {
    constructor() {
        this._queue = [];
        this._closed = false;
        this._waiters = [];
        this._cancelEpoch = 0;
        this._synthChain = null;
        this._mode = 'auto';
        this._inVoice = false;
        this._pending = '';
        this._speak = '';
        this._tag = '';
        this._voiceSpoke = false;
        this._delims = new Set(['。', '！', '？', '.', '!', '?', '\n']);
    }
    push(msg) {
        if (this._closed) return;
        const waiter = this._waiters.shift();
        if (waiter) waiter.resolve({ value: msg, done: false });
        else this._queue.push(msg);
    }
    close() {
        if (this._closed) return;
        this._closed = true;
        for (const w of this._waiters) w.resolve({ done: true });
        this._waiters = [];
        this._queue = [];
    }
    clear() {
        this._queue = [];
        for (const w of this._waiters) w.resolve({ value: TTS_FLUSH, done: false });
        this._waiters = [];
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

    bumpCancelEpoch() {
        this._cancelEpoch += 1;
        return this._cancelEpoch;
    }

    getCancelEpoch() {
        return this._cancelEpoch;
    }

    writeText(chunk) {
        const out = [];
        for (const ch of chunk) {
            out.push(...this._consumeTextChar(ch));
        }
        return out;
    }

    flushText() {
        const out = [];
        if (this._tag) {
            out.push(...this._emitSpeakable(this._tag));
            this._tag = '';
        }
        if (this._mode === 'auto') {
            if (this._pending) out.push(this._pending);
            this._pending = '';
            return out.filter(Boolean);
        }
        if (this._speak) out.push(this._speak);
        this._speak = '';
        return out.filter(Boolean);
    }

    resetText() {
        this._mode = 'auto';
        this._inVoice = false;
        this._voiceSpoke = false;
        this._pending = '';
        this._speak = '';
        this._tag = '';
    }

    _consumeTextChar(ch) {
        if (this._tag || ch === '<') {
            return this._consumeTagChar(ch);
        }
        return this._emitSpeakable(ch);
    }

    _consumeTagChar(ch) {
        const next = this._tag + ch;
        if ('<voice>'.startsWith(next) || '</voice>'.startsWith(next)) {
            this._tag = next;
            if (next === '<voice>') {
                this._tag = '';
                this._voiceSpoke = false;
                if (this._mode === 'auto') {
                    this._mode = 'voice';
                    this._pending = '';
                }
                this._inVoice = true;
            } else if (next === '</voice>') {
                this._tag = '';
                this._inVoice = false;
                // flush any buffered spoken text — voice block is complete
                const flushed = this._speak;
                this._speak = '';
                return flushed ? [flushed] : [];
            }
            return [];
        }

        const buffered = this._tag;
        this._tag = '';
        const out = [];
        if (buffered) out.push(...this._emitSpeakable(buffered));
        return out.concat(this._consumeTextChar(ch));
    }

    _emitSpeakable(text) {
        const out = [];
        const flush = buf => {
            if (buf) out.push(buf);
        };
        for (const ch of text) {
            if (this._mode === 'auto') {
                this._pending += ch;
                if (this._delims.has(ch) || this._pending.length >= MAX_CHUNK) {
                    flush(this._pending);
                    this._pending = '';
                    this._mode = 'full';
                }
                continue;
            }

            if (this._mode === 'voice' && !this._inVoice) {
                continue;
            }

            this._speak += ch;
            const limit = this._voiceSpoke ? VOICE_NEXT : VOICE_FIRST;
            if (this._delims.has(ch) || this._speak.length >= limit) {
                flush(this._speak);
                this._speak = '';
                this._voiceSpoke = true;
            }
        }
        return out.filter(Boolean);
    }
}

// ── per-peer state ────────────────────────────────────────────────

const _queues = new Map(); // peerId → TtsTextQueue

// ── helpers ───────────────────────────────────────────────────────

function stripMarkdownForTts(text) {
    return removeMd(text, {
        stripListLeaders: true,
        gfm: true,
        useImgAltText: false,
        replaceLinksWithURL: false
    }).trim();
}

// ── TTS synthesis (called by consumer when a sentence is ready) ───

async function _synthesize(text, peerId, opts, queue = _queues.get(peerId)) {
    const { cfg, accountId, session, onPcm } = opts;

    const ttsConfig = resolveTtsConfig(cfg, { channelId: 'agentthere' });
    const ttsPrefsPath = resolveTtsPrefsPath(ttsConfig);
    const activeProvider = getTtsProvider(ttsConfig, ttsPrefsPath);
    const cleaned = text.trim();

    // -- TTS directives (voice / model override) ---------------
    const directive = parseTtsDirectives(cleaned, ttsConfig.modelOverrides, {
        cfg,
        providerConfigs: ttsConfig.providerConfigs,
        preferredProviderId: activeProvider
    });

    const textToSynth = stripMarkdownForTts(directive.cleanedText);
    if (!textToSynth) return;

    const overrides = directive.hasDirective ? directive.overrides : undefined;
    console.log(
        `[tts] queueing TTS: text="${textToSynth}" overrides=${overrides ? JSON.stringify(overrides) : 'none'} peerId=${peerId}`
    );

    // -- chain serialisation (one synth+play at a time) --------
    const synthPromise = (async () => {
        try {
            const result = await synthesizeSpeech({ text: textToSynth, cfg, channel: 'agentthere', overrides });
            return result;
        } catch (err) {
            console.error(`[${accountId}] TTS synth error: ${String(err)}`);
            return null;
        }
    })();

    // Notify index that TTS is starting
    if (!queue?._synthChain && session) {
        opts.onResume?.();
    }
    if (session) {
        opts.onBusyChange?.(1);
        opts.onCancelIdle?.();
    }

    const cancelEpoch = queue?.getCancelEpoch() ?? 0;
    const onError = queue?._onError;
    const prevChain = queue?._synthChain ?? Promise.resolve();
    const nextChain = prevChain.then(async () => {
        if ((queue?.getCancelEpoch() ?? 0) !== cancelEpoch) return;
        const result = await synthPromise;
        if (!result?.success || !result.audioBuffer) {
            console.log(`[${accountId}] TTS skipped: ${result?.error ?? 'no audio'}`);
            onError?.(`TTS synthesis failed: ${result?.error ?? 'no audio'}`);
            return;
        }
        const pcm = await decodeTtsAudioToPcm16(result.audioBuffer, result.outputFormat);
        if (!pcm || pcm.length === 0) {
            console.log(`[tts] decode failed for ${peerId}: outputFormat=${result.outputFormat}`);
            onError?.(`TTS decode failed (${result.outputFormat})`);
            return;
        }
        await onPcm(pcm);
        console.log(`[${accountId}] TTS sent "${textToSynth}" → ${Math.floor(pcm.length / 1920)} frames`);
    });
    if (queue) queue._synthChain = nextChain;
    nextChain.finally(() => {
        opts.onBusyChange?.(-1);
    });
    return nextChain;
}

// ── consumer loop ─────────────────────────────────────────────────

function _startConsumer(peerId, opts) {
    const queue = _queues.get(peerId);
    if (!queue) return;

    (async () => {
        for await (const msg of queue) {
            if (msg === TTS_FLUSH) {
                const chunks = queue.flushText();
                for (const text of chunks) {
                    _synthesize(text, peerId, opts, queue);
                }
                continue;
            }

            const chunks = queue.writeText(msg);
            for (const text of chunks) {
                _synthesize(text, peerId, opts, queue);
            }
        }
        for (const text of queue.flushText()) {
            try {
                _synthesize(text, peerId, opts, queue);
            } catch {
                /* ignore */
            }
        }
        _queues.delete(peerId);
        queue._synthChain = null;
    })().catch(err => {
        console.error(`[tts] consumer error for ${peerId}: ${String(err)}`);
    });
}

// ── public API ────────────────────────────────────────────────────

/**
 * Start the TTS pipeline for a peer.
 *
 * @param {string} peerId
 * @param {object} opts
 * @param {object} opts.cfg
 * @param {string} opts.accountId
 * @param {object} opts.session              voice session entry
 * @param {(pcm: Buffer) => Promise<void>} opts.onPcm   receive decoded PCM audio
 * @param {() => void} opts.onStop                       stop current playback
 * @param {() => void} [opts.onResume]                   resume playback
 * @param {(ms: number) => void} [opts.onSilence]   update silence duration
 * @param {(delta: number) => void} [opts.onBusyChange]  track busy count
 * @param {() => void} [opts.onCancelIdle]          cancel idle timer
 */
export function ensureTtsConsumer(peerId, opts) {
    if (_queues.has(peerId)) {
        _queues.get(peerId).push(TTS_FLUSH);
        return;
    }
    const q = new TtsTextQueue();
    q._onError = opts.onError;
    _queues.set(peerId, q);
    _startConsumer(peerId, opts);
}

export function pushTtsDelta(peerId, delta) {
    const q = _queues.get(peerId);
    if (q) q.push(delta);
}

export function pushTtsFlush(peerId) {
    const q = _queues.get(peerId);
    if (q) q.push(TTS_FLUSH);
}

export function closeTtsQueue(peerId) {
    const q = _queues.get(peerId);
    if (q) q.close();
    q?.resetText();
}

/**
 * Cancel pending TTS for a peer — stops playback, discards queued text,
 * and bumps the generation counter so in-progress synthesis is dropped.
 * The consumer stays alive; new TTS can flow immediately.
 */
export function cancelTtsQueue(peerId, onStop) {
    const q = _queues.get(peerId);
    onStop?.();
    q?.clear();
    q._synthChain = null;
    q?.bumpCancelEpoch();
    q?.resetText();
}

export { TTS_FLUSH };
