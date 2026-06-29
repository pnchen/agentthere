/**
 * Outbound media sender — PCM → Opus RTP → WebRTC peer.
 *
 * Usage:
 *   res.mediaOut = new MediaOutSender(peerId, groupId);
 *   await res.mediaOut.play(pcmBuf);   // paced TTS playback
 *   res.mediaOut.stop();               // interrupt mid-playback
 *   res.mediaOut.resume();             // clear break flag
 *   res.mediaOut.close();              // teardown
 */

// ── lazy Opus encoder ──────────────────────────────────────────────

import { getPeers } from '../rtc/index.js';

let _encodeOpusRtp;
let _FRAME_SAMPLES;
async function _getOpusEncoder() {
    if (!_encodeOpusRtp) {
        const mod = await import('../route/call/opus-codec.js');
        _encodeOpusRtp = mod.encodeOpusRtp;
        _FRAME_SAMPLES = mod.FRAME_SAMPLES;
    }
    return { encodeOpusRtp: _encodeOpusRtp, FRAME_SAMPLES: _FRAME_SAMPLES };
}

const IDLE_MS = 15_000;

export class MediaOutSender {
    constructor(peerId, groupId) {
        this._peerId = peerId;
        this._groupId = groupId;
        this._seq = 0;
        this._ts = (Math.random() * 0xffffffff) >>> 0;
        this._ssrc = 0x50414e00 + ((Math.random() * 0xffff) | 0);
        this._peer = null;
        this._pending = null;
        this._idleTimer = null;
        this._cancelled = false;
        this._breakRequested = false;
    }

    // ── peer idle timer ────────────────────────────────────────────

    _clearIdle() {
        if (this._idleTimer) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }
    }

    _armIdle() {
        this._clearIdle();
        this._idleTimer = setTimeout(() => {
            this._idleTimer = null;
            if (!this._peer) return;
            try {
                this._peer.close();
            } catch {
                /* ignore */
            }
            this._peer = null;
        }, IDLE_MS);
    }

    // ── peer acquisition ───────────────────────────────────────────

    async _ensurePeer() {
        if (this._peer) return this._peer;
        if (this._pending) return this._pending;
        this._pending = (async () => {
            try {
                const peer = getPeers()?.get(`${this._groupId}.${this._peerId}`);
                if (!peer) return null;
                const mediaPeer = await peer.ensureMediaOutPeer();
                if (mediaPeer?.ready) {
                    try {
                        await mediaPeer.ready;
                    } catch {
                        return null;
                    }
                }
                this._peer = mediaPeer;
                return mediaPeer;
            } catch {
                return null;
            } finally {
                this._pending = null;
            }
        })();
        return this._pending;
    }

    // ── frame send ─────────────────────────────────────────────────

    async _sendFrame(pcmFrame) {
        const peer = await this._ensurePeer();
        if (!peer) return false;
        const { encodeOpusRtp, FRAME_SAMPLES } = await _getOpusEncoder();
        const rtp = await encodeOpusRtp(pcmFrame, this._seq, this._ts, this._ssrc);
        if (!rtp) return false;
        try {
            peer.sendAudioFrame(rtp);
        } catch {
            this._peer = null;
            return false;
        }
        this._seq = (this._seq + 1) & 0xffff;
        this._ts = (this._ts + FRAME_SAMPLES) >>> 0;
        this._armIdle();
        return true;
    }

    // ── public API ─────────────────────────────────────────────────

    /** Play a PCM buffer paced at 20ms/frame. Respects stop(). */
    async play(pcmBuf) {
        this._cancelled = false;
        const { FRAME_SAMPLES } = await _getOpusEncoder();
        const frameBytes = FRAME_SAMPLES * 2;
        const frameCount = Math.floor(pcmBuf.length / frameBytes);
        const sendStart = Date.now();
        for (let i = 0; i < frameCount; i++) {
            if (this._cancelled) break;
            const offset = i * frameBytes;
            const frame = pcmBuf.subarray(offset, offset + frameBytes);
            await this._sendFrame(frame);
            const delay = sendStart + (i + 1) * 20 - Date.now();
            if (delay > 0) await new Promise(r => setTimeout(r, delay));
        }
    }

    /** Interrupt current play(). */
    stop() {
        this._cancelled = true;
        this._breakRequested = true;
    }

    /** Clear break flag so subsequent play() calls proceed. */
    resume() {
        this._breakRequested = false;
    }

    /** Close the outbound peer and cancel any in-flight send. */
    close() {
        this._cancelled = true;
        this._clearIdle();
        if (this._peer) {
            try {
                this._peer.close();
            } catch {
                /* ignore */
            }
            this._peer = null;
        }
    }
}
