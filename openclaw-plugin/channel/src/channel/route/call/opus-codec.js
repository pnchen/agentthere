/**
 * AgentThere Opus codec utilities — pure Opus encode/decode functions.
 *
 * Callers own the wire side: they read RTP from / write RTP to their own
 * WebRTC track, calling `decodeOpus(rtp) → pcm` or `encodeOpusRtp(pcm, …) → rtp`.
 *
 * Opus codec: payload type 111, 48000 Hz mono, 20ms frames (960 samples/frame).
 *
 * Dependencies (lazy, loaded only when a voice call starts):
 *   - Encoder: opusscript (WASM libopus 1.4)
 *   - Decoder: opus-decoder (WASM)
 */

let opus_encoder = null;
let opus_decoder = null;
let opus_load_promise = null;

export const FRAME_SAMPLES = 960;

async function _ensureOpus() {
    if (opus_encoder && opus_decoder) return;
    if (opus_load_promise) return opus_load_promise;
    opus_load_promise = (async () => {
        try {
            const { createRequire } = await import('node:module');
            const req = createRequire(import.meta.url);

            const OpusScript = req('opusscript');
            if (typeof OpusScript === 'function') {
                opus_encoder = new OpusScript(48000, 1, OpusScript.Application.AUDIO);
                console.log('[opus-codec] OpusScript encoder ready');
            }

            const { OpusDecoder } = await import('opus-decoder');
            const dec = new OpusDecoder();
            await dec.ready;
            opus_decoder = dec;
            console.log('[opus-codec] opus-decoder ready');
        } catch (err) {
            console.log(`[opus-codec] Opus load failed: ${err.message}`);
        }
    })();
    return opus_load_promise;
}

/**
 * Decode an inbound RTP packet containing Opus audio.
 * node-datachannel surfaces raw RTP on inbound tracks, so we parse the
 * RTP header (CSRC + optional extension) then hand the payload to libopus.
 *
 * @returns Buffer of 16-bit signed PCM samples at 48 kHz mono, or null if
 *          decoding fails or the codec is not yet ready.
 */
let _diagCounts = {};
let _diagLastTs = 0;

function _diag(reason, detail) {
    const now = Date.now();
    if (now - _diagLastTs > 10_000) {
        _diagCounts = {};
        _diagLastTs = now;
    }
    _diagCounts[reason] = (_diagCounts[reason] ?? 0) + 1;
    // Log first occurrence + every 500th thereafter for each reason.
    if (_diagCounts[reason] === 1 || _diagCounts[reason] % 500 === 0) {
        console.log(`[opus-codec] decodeOpus null (${reason}, n=${_diagCounts[reason]}): ${detail}`);
    }
}

export async function decodeOpus(rtp_buf) {
    if (rtp_buf.length < 12) {
        _diag('too-short', `len=${rtp_buf.length}`);
        return null;
    }
    const byte0 = rtp_buf[0];
    const version = (byte0 >> 6) & 0x03;
    if (version !== 2) {
        _diag('bad-version', `ver=${version} len=${rtp_buf.length}`);
        return null;
    }
    const byte1 = rtp_buf[1];
    const payload_type = byte1 & 0x7f;
    // PT 111 is Opus (per our SDP). Anything else (RTCP 72-76 / 200-204, comfort
    // noise, telephone-event, etc.) is not for the Opus decoder.
    if (payload_type !== 111) {
        _diag('bad-pt', `pt=${payload_type} len=${rtp_buf.length}`);
        return null;
    }

    const csrc_count = byte0 & 0x0f;
    const has_padding = (byte0 & 0x20) !== 0;
    let offset = 12 + csrc_count * 4;
    if (offset > rtp_buf.length) {
        _diag('csrc-overflow', `csrc=${csrc_count} len=${rtp_buf.length}`);
        return null;
    }

    const has_extension = (byte0 & 0x10) !== 0;
    if (has_extension) {
        if (rtp_buf.length < offset + 4) {
            _diag('ext-too-short', `len=${rtp_buf.length} offset=${offset}`);
            return null;
        }
        const ext_len = rtp_buf.readUInt16BE(offset + 2);
        offset += 4 + ext_len * 4;
        if (offset > rtp_buf.length) {
            _diag('ext-overflow', `extLen=${ext_len} len=${rtp_buf.length}`);
            return null;
        }
    }

    let end = rtp_buf.length;
    if (has_padding) {
        const pad_len = rtp_buf[end - 1];
        if (pad_len === 0 || end - pad_len < offset) {
            _diag('bad-padding', `pad=${pad_len} len=${rtp_buf.length} offset=${offset}`);
            return null;
        }
        end -= pad_len;
    }

    const opus_payload = rtp_buf.subarray(offset, end);
    if (opus_payload.length === 0) {
        _diag('empty-payload', `len=${rtp_buf.length} offset=${offset} end=${end}`);
        return null;
    }

    await _ensureOpus();
    if (!opus_decoder) {
        _diag('no-decoder', `opus-decoder not loaded`);
        return null;
    }
    try {
        const result = opus_decoder.decodeFrame(opus_payload);
        const float_data = result?.channelData?.[0];
        if (!float_data) {
            _diag('decode-empty', `plen=${opus_payload.length} head=${opus_payload.subarray(0, 8).toString('hex')}`);
            return null;
        }
        const pcm = Buffer.alloc(float_data.length * 2);
        for (let i = 0; i < float_data.length; i++) {
            const sample = Math.max(-32768, Math.min(32767, Math.round(float_data[i] * 32768)));
            pcm.writeInt16LE(sample, i * 2);
        }
        return pcm;
    } catch (err) {
        _diag('decode-error', `plen=${opus_payload.length} head=${opus_payload.subarray(0, 8).toString('hex')}: ${err.message}`);
        return null;
    }
}

/**
 * Encode one 20ms PCM16 frame (48 kHz mono, 960 samples = 1920 bytes) into a
 * complete RTP packet with header. Caller owns sequence number, timestamp, and
 * SSRC bookkeeping.
 *
 * @returns Buffer (RTP packet) or null if the encoder is not ready / fails.
 */
export async function encodeOpusRtp(pcm_buf, seq, ts, ssrc) {
    await _ensureOpus();
    if (!opus_encoder) return null;
    let opus_payload;
    try {
        const _buf = Buffer.isBuffer(pcm_buf) ? pcm_buf : Buffer.from(pcm_buf);
        opus_payload = opus_encoder.encode(_buf, FRAME_SAMPLES);
    } catch (e) {
        console.log(`[opus-codec] encodeOpusRtp: encode error: ${e.message}`);
        return null;
    }
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = 111; // Opus payload type
    header.writeUInt16BE(seq & 0xffff, 2);
    header.writeUInt32BE(ts >>> 0, 4);
    header.writeUInt32BE(ssrc >>> 0, 8);
    return Buffer.concat([header, opus_payload]);
}
