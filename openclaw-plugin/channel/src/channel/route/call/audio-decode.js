/**
 * Audio format decode for TTS output — decode non-PCM16 formats into PCM16
 * at 48 kHz mono so Opus RTP pipeline (createOutboundAudioSender /
 * playPcmBuffer) can consume them.
 *
 *   pcm16 / pcm / raw — pass through
 *   wav — strip RIFF header, extract PCM
 *   opus — detect container (WebM by 0x1A45DFA3, Ogg by "OggS")
 *          then extract raw Opus frames and decode via opus-decoder
 *   mp3, flac, aac, ogg-vorbis — delegated to ffmpeg (rare for TTS)
 */

import { spawn } from 'node:child_process';

const FFMPEG_BIN = 'ffmpeg';
const DECODE_TIMEOUT_MS = 10_000;

// ── opus-decoder (lazy WASM init, shared) ────────────────────────────────

let _opus_decoder = null;
let _opus_decoder_ready = null;

async function _ensureOpusDecoder() {
    if (_opus_decoder) return;
    if (_opus_decoder_ready) return _opus_decoder_ready;
    _opus_decoder_ready = (async () => {
        try {
            const { OpusDecoder } = await import('opus-decoder');
            const dec = new OpusDecoder({ channels: 1, sampleRate: 48000 });
            await dec.ready;
            _opus_decoder = dec;
        } catch (err) {
            console.log(`[agentthere-audio-decode] opus-decoder load failed: ${err.message}`);
        }
    })();
    return _opus_decoder_ready;
}

function floatToPcm16(floatData) {
    const pcm = Buffer.alloc(floatData.length * 2);
    for (let i = 0; i < floatData.length; i++) {
        const sample = Math.max(-32768, Math.min(32767, Math.round(floatData[i] * 32768)));
        pcm.writeInt16LE(sample, i * 2);
    }
    return pcm;
}

// ── EBML / WebM minimal scanner ──────────────────────────────────────────
//
// We only need raw Opus frames from SimpleBlocks.  Instead of a full EBML
// parser, we scan for known element-id byte sequences and read their
// data-size VINTs.  This avoids Element-ID VINT edge cases entirely.
//
// WebM layout for a single Opus track (what OpenAI returns):
//   EBML(1A45DFA3) + size + data
//   Segment(18538067) + "unknown" size (all remaining bytes)
//     Info(1549A966) … SeekHead(114D9B74) … Tracks(1654AE6B) …
//     Cluster(1F43B675) + size
//       Timestamp(E7) …
//       SimpleBlock(A3) + size
//         [trackNum(VINT)|timestamp(i16)|flags(u8)|opusFrame…]

// Known 4-byte EBML element IDs (big-endian byte sequences).
const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_CLUSTER = 0x1f43b675;
const ID_E7 = 0xe7; // Timestamp (1-byte element ID)

/** Parse a VINT-encoded data size. Returns {value, len} or null. */
function readDataSize(buf, offset) {
    if (offset >= buf.length) return null;
    const first = buf[offset];
    if (first === 0) return null;
    // Count leading zeros → total bytes
    let len = 0;
    let mask = 0x80;
    while (mask && !(first & mask)) {
        len++;
        mask >>= 1;
    }
    len++; // includes the "1" marker byte
    if (offset + len > buf.length) return null;

    let value = first & (mask - 1);
    // Use * 256 + byte instead of << 8 | byte — JS bitwise ops are int32,
    // which corrupts VINTs wider than 4 bytes.
    for (let i = 1; i < len; i++) {
        value = value * 256 + buf[offset + i];
    }
    return { value, len };
}

/** Read a big-endian u32 from buf at offset. */
function readU32(buf, offset) {
    return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

/**
 * Extract raw Opus frames from a WebM buffer.
 *
 * Scans for Segment → Cluster → SimpleBlock, extracting the raw Opus
 * frame data from each SimpleBlock payload.
 */
/** Return true when the VINT at (offset, vintLen) encodes "unknown size" (all data bits = 1). */
function isUnknownSizeVint(buf, offset, vintLen) {
    // All bytes after the first must be 0xFF.
    for (let i = offset + 1; i < offset + vintLen; i++) {
        if (buf[i] !== 0xff) return false;
    }
    // The first byte's data bits (bits after the length marker '1') must all be 1.
    // For vintLen=1 that means first byte = 0xFF (marker at bit 7, data = 7'b1111111).
    // For vintLen>1 the first byte's data bits are below the marker — they must all be 1.
    const first = buf[offset];
    let dataMask = 0;
    let m = 0x80;
    while (m && !(first & m)) {
        m >>= 1;
    }
    return (first & (m - 1)) === m - 1;
}

function extractWebMOpusFrames(buf) {
    console.log(`[agentthere-audio-decode] webm: scanning ${buf.length}B`);

    // 1. Find Segment start.
    let segStart = -1;
    for (let i = 0; i <= buf.length - 8; i++) {
        if (readU32(buf, i) === ID_EBML) {
            const sz = readDataSize(buf, i + 4);
            if (sz) i = i + 4 + sz.len + sz.value - 1;
            continue;
        }
        if (readU32(buf, i) === ID_SEGMENT) {
            segStart = i;
            break;
        }
    }
    if (segStart < 0) {
        console.log('[agentthere-audio-decode] webm: Segment not found');
        return null;
    }
    console.log(`[agentthere-audio-decode] webm: Segment at offset ${segStart}`);

    // Segment data starts after its id (4) + size VINT.
    const segSize = readDataSize(buf, segStart + 4);
    if (!segSize) return null;
    let pos = segStart + 4 + segSize.len;
    const segEnd = isUnknownSizeVint(buf, segStart + 4, segSize.len) ? buf.length : pos + segSize.value;
    console.log(
        `[agentthere-audio-decode] webm: Segment data at ${pos}, sizeVintLen=${segSize.len}, size=${segSize.value}, end=${segEnd}, unknown=${isUnknownSizeVint(buf, segStart + 4, segSize.len)}`
    );

    // 2. Scan Segment data for Clusters.
    const frames = [];
    let clusterCount = 0;
    while (pos <= segEnd - 8 && pos < buf.length) {
        const id32 = readU32(buf, pos);

        if (id32 === ID_CLUSTER) {
            clusterCount++;
            const clSize = readDataSize(buf, pos + 4);
            if (!clSize) break;
            const clData = pos + 4 + clSize.len;
            let clEnd;
            if (isUnknownSizeVint(buf, pos + 4, clSize.len)) {
                // Unknown-size Cluster: scan forward for the next Cluster or use Segment end.
                clEnd = segEnd;
                for (let s = clData; s <= segEnd - 8 && s < buf.length; s++) {
                    if (readU32(buf, s) === ID_CLUSTER) {
                        clEnd = s;
                        break;
                    }
                }
            } else {
                clEnd = Math.min(clData + clSize.value, segEnd, buf.length);
            }
            // Walk Cluster children for SimpleBlocks.
            let cp = clData;
            let sbCount = 0;
            while (cp < clEnd && cp < buf.length) {
                // 1-byte element IDs: Timestamp (E7), SimpleBlock (A3)
                if (buf[cp] === ID_E7) {
                    const tsSz = readDataSize(buf, cp + 1);
                    cp = tsSz ? cp + 1 + tsSz.len + tsSz.value : cp + 1;
                    continue;
                }

                if (buf[cp] === 0xa3) {
                    sbCount++;
                    const sbSize = readDataSize(buf, cp + 1);
                    if (!sbSize) {
                        cp++;
                        continue;
                    }
                    const sbData = cp + 1 + sbSize.len;
                    const sbEnd = Math.min(sbData + sbSize.value, clEnd, buf.length);

                    // SimpleBlock payload: trackNum(VINT) | timestamp(i16) | flags(u8) | frame[]
                    const trackNum = readDataSize(buf, sbData);
                    if (trackNum) {
                        const frameStart = sbData + trackNum.len + 2 + 1;
                        if (frameStart < sbEnd) {
                            const frameData = buf.subarray(frameStart, sbEnd);
                            if (frameData.length >= 10) {
                                frames.push(frameData);
                            }
                        }
                    }
                    cp = sbEnd;
                    continue;
                }

                // Unknown element inside Cluster. 1-byte IDs have bit 7 set.
                if (buf[cp] & 0x80) {
                    const sz = readDataSize(buf, cp + 1);
                    cp = sz ? cp + 1 + sz.len + sz.value : cp + 1;
                } else {
                    const sz = readDataSize(buf, cp + 4);
                    cp = sz ? cp + 4 + sz.len + sz.value : cp + 1;
                }
            }
            pos = clEnd;
        } else {
            pos++;
        }
    }

    return frames.length > 0 ? frames : null;
}

async function decodeWebMOpusToPcm16(buf) {
    await _ensureOpusDecoder();
    if (!_opus_decoder) return null;

    const frames = extractWebMOpusFrames(buf);
    if (!frames || frames.length === 0) {
        console.log('[agentthere-audio-decode] webm: no SimpleBlocks found');
        return null;
    }

    try {
        const result = _opus_decoder.decodeFrames(frames);
        const floatData = result?.channelData?.[0];
        if (!floatData || floatData.length === 0) return null;
        return floatToPcm16(floatData);
    } catch (err) {
        console.log(`[agentthere-audio-decode] webm opus decode error: ${err.message}`);
        return null;
    }
}

// ── Ogg Opus (for providers that use Ogg container) ──────────────────────

function parseOggPackets(buf) {
    const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    const packets = [];
    let pageOffset = 0;
    let pending = null;

    while (pageOffset + 27 <= view.length) {
        if (view[pageOffset] !== 0x4f || view[pageOffset + 1] !== 0x67 || view[pageOffset + 2] !== 0x67 || view[pageOffset + 3] !== 0x53) {
            break;
        }

        const headerType = view[pageOffset + 5];
        const continued = (headerType & 0x01) !== 0;
        const segCount = view[pageOffset + 26];
        if (pageOffset + 27 + segCount > view.length) break;

        let payloadLen = 0;
        for (let i = 0; i < segCount; i++) {
            payloadLen += view[pageOffset + 27 + i];
        }

        const payloadStart = pageOffset + 27 + segCount;
        if (payloadStart + payloadLen > view.length) break;

        let segPos = payloadStart;
        let currentPacket = continued && pending !== null ? pending : null;

        for (let i = 0; i < segCount; i++) {
            const segLen = view[pageOffset + 27 + i];
            if (segPos + segLen > view.length) break;

            if (currentPacket) {
                const prev = currentPacket;
                const combined = Buffer.alloc(prev.length + segLen);
                prev.copy(combined);
                view.copy(combined, prev.length, segPos, segPos + segLen);
                currentPacket = combined;
            } else {
                currentPacket = Buffer.from(view.subarray(segPos, segPos + segLen));
            }

            if (segLen < 255) {
                packets.push(currentPacket);
                currentPacket = null;
            }
            segPos += segLen;
        }

        pending = currentPacket;
        pageOffset = payloadStart + payloadLen;
    }

    if (pending && pending.length > 0) packets.push(pending);
    return packets;
}

async function decodeOggOpusToPcm16(buf) {
    await _ensureOpusDecoder();
    if (!_opus_decoder) return null;

    const packets = parseOggPackets(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    if (packets.length < 3) {
        console.log(`[agentthere-audio-decode] ogg: too few packets (${packets.length})`);
        return null;
    }

    let start = 0;
    if (packets[0].length >= 8 && packets[0].toString('utf8', 0, 8) === 'OpusHead') {
        start = 2;
    }

    const audioPackets = packets.slice(start).filter(p => p.length >= 10);
    if (audioPackets.length === 0) {
        console.log('[agentthere-audio-decode] ogg: no audio packets after header skip');
        return null;
    }

    try {
        const result = _opus_decoder.decodeFrames(audioPackets);
        const floatData = result?.channelData?.[0];
        if (!floatData || floatData.length === 0) return null;
        return floatToPcm16(floatData);
    } catch (err) {
        console.log(`[agentthere-audio-decode] ogg opus decode error: ${err.message}`);
        return null;
    }
}

// ── ffmpeg fallback (mp3, aac, flac, etc.) ───────────────────────────────

function decodeWithFfmpeg(buf) {
    return new Promise((resolve, reject) => {
        const child = spawn(FFMPEG_BIN, ['-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '1', 'pipe:1'], {
            stdio: ['pipe', 'pipe', 'ignore']
        });

        const chunks = [];
        child.stdout.on('data', chunk => chunks.push(chunk));
        child.stdout.on('end', () => resolve(Buffer.concat(chunks)));
        child.on('error', err => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));

        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(new Error('ffmpeg decode timeout'));
        }, DECODE_TIMEOUT_MS);

        child.on('close', code => {
            clearTimeout(timer);
            if (code !== 0 && chunks.length === 0) {
                reject(new Error(`ffmpeg exited ${code}`));
            }
        });

        child.stdin.end(buf);
    });
}

// ── public API ───────────────────────────────────────────────────────────

/**
 * Decode a TTS audio buffer to PCM16 at 48 kHz mono.
 *
 * @param {Buffer} audioBuffer
 * @param {string|undefined} outputFormat  e.g. "pcm16", "opus", "mp3"
 * @returns {Promise<Buffer|null>}  PCM16 buffer, or null if decoding fails.
 */
export async function decodeTtsAudioToPcm16(audioBuffer, outputFormat) {
    if (!audioBuffer || audioBuffer.length === 0) return null;

    const fmt = (outputFormat ?? '').toLowerCase().trim();

    // Already PCM — pass through.
    if (fmt === 'pcm16' || fmt === 'pcm' || fmt === 'raw' || fmt === '') {
        return Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
    }

    // WAV — fast-path: strip RIFF header.
    if (fmt === 'wav') {
        const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
        const dataOff = buf.indexOf('data', 0);
        if (dataOff >= 0 && dataOff + 8 <= buf.length) {
            const dataSize = buf.readUInt32LE(dataOff + 4);
            const pcmStart = dataOff + 8;
            const pcmEnd = Math.min(pcmStart + dataSize, buf.length);
            return buf.subarray(pcmStart, pcmEnd);
        }
        return buf;
    }

    const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);

    // Opus — detect container by magic bytes.
    if (fmt === 'opus' || fmt === 'ogg' || fmt === 'ogg-opus') {
        // WebM (EBML header: 1A45DFA3) — OpenAI gpt-4o-mini-tts returns this.
        if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
            const t0 = Date.now();
            const pcm = await decodeWebMOpusToPcm16(buf);
            if (pcm) {
                console.log(`[agentthere-audio-decode] webm-opus: ${buf.length}B -> pcm16 ${pcm.length}B (${Date.now() - t0}ms)`);
                return pcm;
            }
            return null;
        }
        // Ogg ("OggS" magic)
        if (buf.length >= 4 && buf[0] === 0x4f && buf[1] === 0x67 && buf[2] === 0x67 && buf[3] === 0x53) {
            const t0 = Date.now();
            const pcm = await decodeOggOpusToPcm16(buf);
            if (pcm) {
                console.log(`[agentthere-audio-decode] ogg-opus: ${buf.length}B -> pcm16 ${pcm.length}B (${Date.now() - t0}ms)`);
                return pcm;
            }
            return null;
        }
        // Unknown container — try raw Opus frame decode as fallback.
        await _ensureOpusDecoder();
        if (!_opus_decoder) return null;
        try {
            const result = _opus_decoder.decodeFrame(buf);
            const floatData = result?.channelData?.[0];
            if (!floatData || floatData.length === 0) return null;
            return floatToPcm16(floatData);
        } catch (err) {
            console.log(`[agentthere-audio-decode] raw-opus decode error: ${err.message}`);
            return null;
        }
    }

    // MP3 and everything else — ffmpeg.
    const t0 = Date.now();
    try {
        const pcm = await decodeWithFfmpeg(buf);
        const elapsed = Date.now() - t0;
        console.log(`[agentthere-audio-decode] ffmpeg: ${fmt} ${buf.length}B -> pcm16 ${pcm.length}B (${elapsed}ms)`);
        return pcm.length > 0 ? pcm : null;
    } catch (err) {
        console.log(`[agentthere-audio-decode] ffmpeg decode failed (${fmt}): ${err.message}`);
        return null;
    }
}
