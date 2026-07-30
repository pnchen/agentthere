/**
 * Media task manager.
 *
 * First transport probe: play an H264 video source over a WebRTC video track.
 * The task abstraction is intentionally media-generic so audio tracks can be
 * added later without changing the tool/job lifecycle.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { getGroupPeers } from "../rtc/index.js";
import { createOpusEncoder, encodeOpusRtp, FRAME_SAMPLES } from "../routes/agent/call/opus-codec.js";

const VIDEO_CLOCK_RATE = 90_000;
const AUDIO_CLOCK_RATE = 48_000;
const DEFAULT_FPS = 30;
const AUDIO_FRAME_BYTES = FRAME_SAMPLES * 2;

function probeMediaSource(source) {
    return new Promise((resolve, reject) => {
        const proc = spawn("ffprobe", [
            "-v", "error",
            "-show_entries", "stream=codec_type,codec_name,width,height,bit_rate:format=duration",
            "-of", "json",
            source,
        ], { stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let error = "";
        proc.stdout.on("data", (data) => { output += data.toString(); });
        proc.stderr.on("data", (data) => { error += data.toString(); });
        proc.once("error", reject);
        proc.once("close", (code) => {
            if (code !== 0) {
                reject(new Error(`ffprobe exited code=${code}: ${error.trim()}`));
                return;
            }
            let parsed;
            try { parsed = JSON.parse(output); } catch { reject(new Error("ffprobe: invalid json output")); return; }
            const streams = parsed.streams || [];
            const videoStream = streams.find((s) => s.codec_type === "video");
            const audioStream = streams.find((s) => s.codec_type === "audio");
            const hasVideo = !!videoStream;
            const hasAudio = !!audioStream;
            if (!hasAudio && !hasVideo) {
                reject(new Error("Media source has no audio or video stream"));
                return;
            }
            const info = {
                hasAudio,
                hasVideo,
                mediaKind: hasAudio && hasVideo ? "av" : hasVideo ? "video" : "audio",
                duration: parseFloat(parsed.format?.duration) || 0,
            };
            if (videoStream) {
                info.videoCodec = videoStream.codec_name || "unknown";
                info.width = videoStream.width || 0;
                info.height = videoStream.height || 0;
                info.bitRate = parseInt(videoStream.bit_rate, 10) || 0;
            }
            resolve(info);
        });
    });
}

function findStartCode(buffer, from = 0) {
    for (let i = from; i + 3 < buffer.length; i++) {
        if (buffer[i] !== 0 || buffer[i + 1] !== 0) continue;
        if (buffer[i + 2] === 1) return { index: i, length: 3 };
        if (i + 4 < buffer.length && buffer[i + 2] === 0 && buffer[i + 3] === 1) {
            return { index: i, length: 4 };
        }
    }
    return null;
}

class H264AccessUnitParser {
    buffer = Buffer.alloc(0);
    pendingUnits = [];

    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const frames = [];

        while (true) {
            const first = findStartCode(this.buffer);
            if (!first) {
                this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 4));
                break;
            }
            if (first.index > 0) {
                this.buffer = this.buffer.subarray(first.index);
            }
            const second = findStartCode(this.buffer, first.length);
            if (!second) break;

            const unit = this.buffer.subarray(0, second.index);
            this.buffer = this.buffer.subarray(second.index);
            this._pushUnit(unit, frames);
        }
        return frames;
    }

    flush() {
        const frames = [];
        const first = findStartCode(this.buffer);
        if (first) {
            this._pushUnit(this.buffer.subarray(first.index), frames);
        }
        this.buffer = Buffer.alloc(0);
        if (this.pendingUnits.length > 0) {
            frames.push(Buffer.concat(this.pendingUnits));
            this.pendingUnits = [];
        }
        return frames;
    }

    _pushUnit(unit, frames) {
        const start = findStartCode(unit);
        if (!start || unit.length <= start.index + start.length) return;
        const nalType = unit[start.index + start.length] & 0x1f;
        // Access Unit Delimiter marks the start of a new decoded picture.
        if (nalType === 9 && this.pendingUnits.length > 0) {
            frames.push(Buffer.concat(this.pendingUnits));
            this.pendingUnits = [];
        }
        this.pendingUnits.push(unit);
    }
}

export class MediaTask {
    constructor({ taskId, source, groupId, peers, fps = DEFAULT_FPS, loop = false }) {
        this.taskId = taskId;
        this.source = source;
        this.groupId = groupId;
        this.peers = peers;
        this.fps = fps;
        this.loop = loop;
        this.mediaKind = null;
        this.hasAudio = false;
        this.hasVideo = false;
        this.videoCodec = null;
        this.width = 0;
        this.height = 0;
        this.bitRate = 0;
        this.duration = 0;
        this.state = "created";
        this._seekTo = 0;
        this.error = null;
        this.startedAt = null;
        this.frameCount = 0;
        this.audioFrameCount = 0;
        this.audioSequence = 0;
        this.audioTimestamp = 0;
        this.audioSsrc = (Math.random() * 0xffffffff) >>> 0;
        this.audioBuffer = Buffer.alloc(0);
        this.audioQueuedFrames = 0;
        this.audioStartAt = null;
        this.audioSendChain = Promise.resolve();
        this.audioEncoder = null;
        this.process = null;
        this._processExitPromise = null;
        this._runGeneration = 0;
        this._seekOperation = 0;
        this._runControlPromise = Promise.resolve();
        this.mediaPeers = [];
        this._stopped = false;
    }

    async start() {
        if (this.state !== "created") return;
        this.startedAt = Date.now();
        this.state = "starting";
        try {
            const probed = await probeMediaSource(this.source);
            this.mediaKind = probed.mediaKind;
            this.hasAudio = probed.hasAudio;
            this.hasVideo = probed.hasVideo;
            if (probed.videoCodec) {
                this.videoCodec = probed.videoCodec;
                this.width = probed.width;
                this.height = probed.height;
                this.bitRate = probed.bitRate;
            }
            this.duration = probed.duration || 0;
            console.log(`[media-task:${this.taskId}] source mediaKind=${this.mediaKind} codec=${this.videoCodec} ${this.width}x${this.height} bitrate=${this.bitRate} duration=${this.duration}`);
            this.mediaPeers = await Promise.all(this.peers.map(async (peer) => {
                console.log(`[media-task:${this.taskId}] waiting media peer peer=${peer.peerId}`);
                const mediaPeer = await peer.ensureMediaTaskOutPeer({
                    mediaKind: this.mediaKind,
                    mediaId: this.taskId,
                    onClose: () => this._removeMediaPeer(peer.peerId),
                });
                await mediaPeer.ready;
                console.log(`[media-task:${this.taskId}] media peer ready peer=${peer.peerId}`);
                return { peer, mediaPeer };
            }));
            if (this.mediaPeers.length === 0) {
                throw new Error("No connected media peers");
            }
            await this._runFfmpeg();
        }
        catch (err) {
            if (!this._stopped && this.state !== "failed") {
                this.state = "failed";
                this.error = String(err);
                console.error(`[media-task:${this.taskId}] failed: ${this.error}`);
            }
        }
    }

    async _runFfmpeg() {
        const runGeneration = ++this._runGeneration;
        const seekPos = this._seekTo;
        const args = ["-hide_banner", "-loglevel", "error", "-re"];
        if (seekPos > 0) args.push("-ss", String(seekPos));
        args.push("-i", this.source);
        const audioPipe = this.hasVideo ? "pipe:3" : "pipe:1";
        if (this.hasVideo) {
            // Scale down to max 1280 wide, keep aspect ratio. Cap bitrate to
            // avoid saturating the WebRTC data channel.
            const maxWidth = 1280;
            const maxBitrate = "2M";
            const scaleFilter = this.width > maxWidth
                ? `scale=${maxWidth}:-2`
                : "scale=trunc(iw/2)*2:trunc(ih/2)*2"; // force even dimensions
            args.push(
                "-map", "0:v:0",
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-tune", "zerolatency",
                "-pix_fmt", "yuv420p",
                "-profile:v", "baseline",
                "-b:v", maxBitrate,
                "-maxrate", maxBitrate,
                "-bufsize", "4M",
                "-r", String(this.fps),
                "-bf", "0",
                "-vf", scaleFilter,
                "-g", String(this.fps * 2),
                "-bsf:v", "h264_metadata=aud=insert",
                "-f", "h264",
                "pipe:1",
            );
        }
        if (this.hasAudio) {
            args.push(
                "-map", "0:a:0",
                "-vn",
                "-ac", "1",
                "-ar", String(AUDIO_CLOCK_RATE),
                "-f", "s16le",
                audioPipe,
            );
        }

        this.state = "playing";
        console.log(`[media-task:${this.taskId}] ffmpeg ${args.join(" ")}`);
        const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe", "pipe"] });
        this.process = proc;
        let resolveProcessExit;
        const processExit = new Promise((resolve) => { resolveProcessExit = resolve; });
        this._processExitPromise = processExit;
        const parser = new H264AccessUnitParser();
        const timestampStep = VIDEO_CLOCK_RATE / this.fps;

        proc.stderr.on("data", (data) => {
            if (runGeneration !== this._runGeneration) return;
            const text = data.toString().trim();
            if (!text) return;
            console.error(`[media-task:${this.taskId}] ffmpeg: ${text}`);
            // Detect video encoding failures that would cause silent video loss.
            if (/Error.*video|Video.*error|cannot open video/i.test(text)) {
                this.state = "failed";
                this.error = `ffmpeg video error: ${text.slice(0, 200)}`;
                proc.kill("SIGTERM");
            }
        });
        if (this.hasVideo) {
            proc.stdout.on("data", (data) => {
                if (runGeneration !== this._runGeneration) return;
                const frames = parser.push(data);
                if (frames.length > 0 || this.frameCount === 0) {
                    console.log(`[media-task:${this.taskId}] video stdout bytes=${data.length} frames=${frames.length} total=${this.frameCount}`);
                }
                for (const frame of frames) this._sendVideoFrame(frame, timestampStep);
            });
        }
        if (this.hasAudio) {
            const audioStream = this.hasVideo ? proc.stdio[3] : proc.stdout;
            audioStream?.on("data", (data) => {
                if (runGeneration !== this._runGeneration) return;
                this._sendAudioBytes(data);
            });
        }

        await new Promise((resolve, reject) => {
            proc.once("error", reject);
            proc.once("close", (code, signal) => {
                resolveProcessExit();
                if (this.process === proc) {
                    this.process = null;
                    this._processExitPromise = null;
                }
                if (runGeneration !== this._runGeneration || this._stopped) return resolve();
                if (code === 0 && this.loop) {
                    this._seekTo = 0;
                    this._runFfmpeg().then(resolve, reject);
                    return;
                }
                if (code === 0) {
                    this.state = "completed";
                    resolve();
                }
                else {
                    reject(new Error(`ffmpeg exited code=${code} signal=${signal ?? "none"}`));
                }
            });
        });

        if (runGeneration !== this._runGeneration || this._stopped) return;
        if (this.hasVideo) {
            for (const frame of parser.flush()) this._sendVideoFrame(frame, timestampStep);
        }
        if (this.hasAudio) this._flushAudioBytes();
        await this.audioSendChain;
        if (this.process === proc) this.process = null;
        if (!this._stopped && this.state === "completed") this._closeMediaPeers();
    }

    _removeMediaPeer(peerId) {
        if (this._stopped) return;
        const removed = this.mediaPeers.some(({ peer }) => peer.peerId === peerId);
        if (!removed) return;
        this.mediaPeers = this.mediaPeers.filter(({ peer }) => peer.peerId !== peerId);
        console.warn(`[media-task:${this.taskId}] media peer closed peer=${peerId} remaining=${this.mediaPeers.length}`);
        if (this.mediaPeers.length === 0) this.stop();
    }

    _closeMediaPeers() {
        const peers = this.mediaPeers;
        this.mediaPeers = [];
        for (const { mediaPeer } of peers) {
            try { mediaPeer.close("media-task-finished"); } catch { /* ignore */ }
        }
    }

    _sendVideoFrame(frame, timestampStep) {
        const timestamp = Math.floor(this.frameCount * timestampStep);
        this.frameCount += 1;
        if (this.frameCount <= 3 || this.frameCount % 100 === 0) {
            console.log(`[media-task:${this.taskId}] sending video frame=${this.frameCount} bytes=${frame.length} timestamp=${timestamp}`);
        }
        for (const { peer, mediaPeer } of [...this.mediaPeers]) {
            const sent = mediaPeer.sendVideoFrame(frame, timestamp);
            if (!sent) {
                console.warn(`[media-task:${this.taskId}] video frame send failed peer=${peer.peerId} frame=${this.frameCount}`);
                this._removeMediaPeer(peer.peerId);
            }
        }
    }

    _sendAudioBytes(data) {
        this.audioBuffer = Buffer.concat([this.audioBuffer, data]);
        while (this.audioBuffer.length >= AUDIO_FRAME_BYTES) {
            const frame = this.audioBuffer.subarray(0, AUDIO_FRAME_BYTES);
            this.audioBuffer = this.audioBuffer.subarray(AUDIO_FRAME_BYTES);
            this._sendAudioFrame(frame);
        }
    }

    _flushAudioBytes() {
        if (this.audioBuffer.length === 0) return;
        const frame = Buffer.alloc(AUDIO_FRAME_BYTES);
        this.audioBuffer.copy(frame);
        this.audioBuffer = Buffer.alloc(0);
        this._sendAudioFrame(frame);
    }

    _sendAudioFrame(pcmFrame) {
        const frameIndex = this.audioQueuedFrames++;
        if (this.audioStartAt === null) this.audioStartAt = Date.now();
        this.audioSendChain = this.audioSendChain
            .then(async () => {
                if (this._stopped) return;
                const targetAt = this.audioStartAt + frameIndex * 20;
                const delay = targetAt - Date.now();
                if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
                if (this._stopped) return;

                if (!this.audioEncoder) this.audioEncoder = await createOpusEncoder();
                const opus = await encodeOpusRtp(
                    pcmFrame,
                    this.audioSequence,
                    this.audioTimestamp,
                    this.audioSsrc,
                    this.audioEncoder,
                );
                if (!opus) return;
                this.audioSequence = (this.audioSequence + 1) & 0xffff;
                this.audioTimestamp = (this.audioTimestamp + FRAME_SAMPLES) >>> 0;
                this.audioFrameCount += 1;
                if (this.audioFrameCount <= 3 || this.audioFrameCount % 100 === 0) {
                    console.log(`[media-task:${this.taskId}] sending audio frame=${this.audioFrameCount} bytes=${opus.length}`);
                }
                for (const { peer, mediaPeer } of [...this.mediaPeers]) {
                    const sent = mediaPeer.sendAudioFrame(opus);
                    if (!sent) {
                        console.warn(`[media-task:${this.taskId}] audio frame send failed peer=${peer.peerId} frame=${this.audioFrameCount}`);
                        this._removeMediaPeer(peer.peerId);
                    }
                }
            })
            .catch((err) => {
                if (!this._stopped) console.error(`[media-task:${this.taskId}] audio send failed: ${String(err)}`);
            });
        return this.audioSendChain;
    }

    stop() {
        if (this._stopped) return;
        this._stopped = true;
        this._runGeneration += 1;
        this.state = "stopped";
        this.process?.kill("SIGTERM");
        this._closeMediaPeers();
        console.log(`[media-task:${this.taskId}] stopped`);
    }

    get position() {
        if (this.hasVideo) return this.frameCount / (this.fps || DEFAULT_FPS);
        return this.audioFrameCount / 50;
    }

    async _cancelCurrentRun() {
        const proc = this.process;
        const processExit = this._processExitPromise;
        if (!proc || !processExit) return;
        this._runGeneration += 1;
        proc.kill("SIGTERM");
        await processExit;
    }

    pause() {
        if (this.state !== "playing") return false;
        this.state = "paused";
        this._seekTo = this.position;
        this._runControlPromise = this._cancelCurrentRun();
        console.log(`[media-task:${this.taskId}] paused at ${this._seekTo.toFixed(1)}s`);
        return true;
    }

    async resume() {
        if (this.state !== "paused") return false;
        this.state = "playing";
        await this._runControlPromise;
        if (this._stopped || this.state !== "playing") return false;
        // Reset counters for the new ffmpeg run; _seekTo already holds position.
        this.frameCount = Math.floor(this._seekTo * (this.fps || DEFAULT_FPS));
        this.audioFrameCount = Math.floor(this._seekTo * 50); // 20ms frames
        console.log(`[media-task:${this.taskId}] resuming from ${this._seekTo.toFixed(1)}s`);
        await this._runFfmpeg().catch((err) => {
            if (!this._stopped && this.state !== "failed") {
                this.state = "failed";
                this.error = String(err);
                console.error(`[media-task:${this.taskId}] resume failed: ${this.error}`);
            }
        });
        if (!this._stopped && this.state === "playing") {
            this.state = "completed";
            this._closeMediaPeers();
        }
        return true;
    }

    async seek(pos) {
        if (this.state !== "playing" && this.state !== "paused") return false;
        const wasPaused = this.state === "paused";
        const operation = ++this._seekOperation;
        const target = Math.max(0, Math.min(pos, this.duration || Infinity));
        this._seekTo = target;
        this.frameCount = Math.floor(target * (this.fps || DEFAULT_FPS));
        this.audioFrameCount = Math.floor(target * 50);
        this.audioBuffer = Buffer.alloc(0);
        console.log(`[media-task:${this.taskId}] seeking to ${target.toFixed(1)}s${wasPaused ? " (paused)" : ""}`);

        if (wasPaused) return true;

        this.state = "playing";
        await this._runControlPromise;
        this._runControlPromise = this._cancelCurrentRun();
        await this._runControlPromise;
        if (this._stopped || operation !== this._seekOperation) return false;

        await this._runFfmpeg().catch((err) => {
            if (!this._stopped && operation === this._seekOperation && this.state !== "failed") {
                this.state = "failed";
                this.error = String(err);
                console.error(`[media-task:${this.taskId}] seek failed: ${this.error}`);
            }
        });
        return true;
    }

    status() {
        return {
            taskId: this.taskId,
            source: this.source,
            groupId: this.groupId,
            state: this.state,
            error: this.error,
            mediaKind: this.mediaKind,
            videoCodec: this.videoCodec,
            width: this.width,
            height: this.height,
            bitRate: this.bitRate,
            duration: this.duration,
            position: this.position,
            frameCount: this.frameCount,
            audioFrameCount: this.audioFrameCount,
            startedAt: this.startedAt,
        };
    }
}

export class MediaTaskManager {
    tasks = new Map();

    async start({ source, groupId, fps, loop }) {
        const peers = getGroupPeers(groupId);
        if (peers.length === 0) throw new Error(`No connected peers in group "${groupId}"`);
        const taskId = `media-task-${Date.now()}-${randomUUID().slice(0, 8)}`;
        const task = new MediaTask({ taskId, source, groupId, peers, fps, loop });
        this.tasks.set(taskId, task);
        task.start().finally(() => {
            if (task.state === "completed" || task.state === "failed" || task.state === "stopped") {
                // Keep terminal tasks available for status queries until a new
                // task replaces them or the service shuts down.
            }
        });
        return task;
    }

    stop(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) return false;
        task.stop();
        return true;
    }

    pause(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) return false;
        task.pause();
        return true;
    }

    resume(taskId) {
        const task = this.tasks.get(taskId);
        if (!task) return false;
        task.resume();
        return true;
    }

    seek(taskId, pos) {
        const task = this.tasks.get(taskId);
        if (!task) return false;
        task.seek(pos);
        return true;
    }

    status(taskId) {
        return this.tasks.get(taskId)?.status() ?? null;
    }

    list() {
        return [...this.tasks.values()].map((task) => task.status());
    }

    stopAll() {
        for (const task of this.tasks.values()) task.stop();
        this.tasks.clear();
    }
}
