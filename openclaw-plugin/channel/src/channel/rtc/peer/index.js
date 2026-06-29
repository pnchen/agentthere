/**
 * AgentThere Peer — self-contained lifecycle object for one remote peer.
 *
 * Owns DataChannel, connection loop (offerer retry / non-offerer one-shot),
 * media peers (in/out), signaling via MQTT, and file send.
 *
 * Created and torn down by the RTC orchestrator (../index.js).
 */

import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import { createPeer, createMediaOutPeer, createMediaInPeer } from './pc.js';
import { VADAudioTrackHandle } from './audio-gate.js';
import { createMessageId } from '../../messaging.js';
import { getRuntime } from '../../../runtime.js';

const CHUNK_SIZE = 65536;
const BUFFERED_AMOUNT_THRESHOLD = 256 * 1024;

// ── shared helpers (also exported for orchestrator) ────────────────────

export function hashId(id) {
    return createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
}

function ns(path) {
    const namespace = getRuntime().config?.current()?.channels?.agentthere?.mqtt?.namespace || '';
    return namespace ? `${namespace}/${path}` : path;
}

// ── backpressure helper ─────────────────────────────────────────────────

function waitForDrain(dc, timeoutMs = 30_000) {
    return new Promise(resolve => {
        if (!dc || !dc.isOpen()) return resolve(false);
        if (dc.bufferedAmount() < BUFFERED_AMOUNT_THRESHOLD) return resolve(true);

        dc.setBufferedAmountLowThreshold(BUFFERED_AMOUNT_THRESHOLD);

        let settled = false;
        const settle = value => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            clearInterval(check);
            resolve(value);
        };

        const timer = setTimeout(() => settle(false), timeoutMs);

        dc.onBufferedAmountLow(() => settle(dc.isOpen()));

        const check = setInterval(() => {
            if (!dc.isOpen()) return settle(false);
            if (dc.bufferedAmount() < BUFFERED_AMOUNT_THRESHOLD) return settle(true);
        }, 200);
    });
}

// ── Peer ────────────────────────────────────────────────────────────────

export class Peer {
    /**
     * @param {string} opts.peerId
     * @param {{id: string, profile: object}} opts.agent
     * @param {string} opts.groupId
     * @param {(msg) => void} opts.onRawMessage
     * @param {(info) => void} opts.onInboundStream
     */
    constructor(opts) {
        this.peerId = opts.peerId;
        this.peerName = opts.peerName || opts.peerId;
        this.groupId = opts.groupId;
        this.sessionMode = 'group';

        // Dependencies
        this.agent = opts.agent;
        this.onRawMessage = opts.onRawMessage;
        this.onInboundStream = opts.onInboundStream;

        // Derived
        this.rtc_label = `agentthere/rtc:${opts.groupId}`;
        this.from_remote = ns(`${hashId(opts.peerId)}2${hashId(opts.agent.id)}`);
        this.to_remote = ns(`${hashId(opts.agent.id)}2${hashId(opts.peerId)}`);

        // RTC state
        this.dc = null;
        this.connected = false;
        this.pc = null; // RTCPeerConnection wrapper

        // Media
        this.uid = null;
        this.mediaMeta = null;
        this.mediaInPeer = null;
        this.mediaOutPeer = null;
        this.audioStream = null;

        // Lifecycle
        this.mqtt_client = null;
        this.stopped = false;
        this.offerer = opts.agent.id > opts.peerId;
    }

    // ── connect (called by orchestrator) ────────────────────────────────

    /**
     * Subscribe to per-peer signaling and launch the connection loop.
     *
     * Offerer:  starts a retry-loop (fire-and-forget) that publishes SDP offers.
     * Non-offerer:  awaits a single-shot connection (receives SDP offer, sends answer).
     */
    async connect(mqttClient) {
        this.mqtt_client = mqttClient;

        await this.subscribe();

        if (this.offerer) {
            this.startOffererLoop();
        } else {
            await this.startNonOfferer();
        }

        // On MQTT reconnect, re-subscribe and re-launch.
        this.on_mqtt_client_connect = () => {
            if (this.stopped) return;
            this.subscribe().catch(() => {});
        };
        mqttClient.on('connect', this.on_mqtt_client_connect);
    }

    async subscribe() {
        if (this.on_mqtt_client_message) {
            this.mqtt_client.removeListener('message', this.on_mqtt_client_message);
        }
        await new Promise((resolve, reject) => {
            this.mqtt_client.subscribe(`${this.from_remote}/#`, err => {
                if (err) reject(err);
                else resolve();
            });
        });
        this.on_mqtt_client_message = (topic, msg) => this.handleSignaling(topic, msg);
        this.mqtt_client.on('message', this.on_mqtt_client_message);
    }

    // ── send ────────────────────────────────────────────────────────────

    /** Send a JSON-serialisable text message. Returns false if not connected. */
    send(text) {
        if (!this.dc) return false;
        try {
            if (!this.dc.isOpen()) return false;
            this.dc.sendMessage(text);
            return true;
        } catch (err) {
            console.error(`[agentthere:peer] send error to ${this.peerId}: ${String(err)}`);
            return false;
        }
    }

    /** True if the DataChannel is open and ready. */
    isConnected() {
        return this.connected && this.dc && this.dc.isOpen();
    }

    // ── file send ───────────────────────────────────────────────────────

    async sendFile({ filePath, fileName, mimeType, objectId: _objectId, kind, log }) {
        const stat = fs.statSync(filePath);
        const fileSize = stat.size;
        const objectId = _objectId ?? randomUUID().replace(/-/g, '').slice(0, 16);
        const messageId = createMessageId();

        const meta = {
            id: messageId,
            file: { name: fileName, size: fileSize, type: mimeType },
            object_id: objectId,
            from: this.agent.profile
        };
        if (kind) meta.kind = kind;
        if (!this.send(JSON.stringify(meta))) {
            log?.('[agentthere/file] failed to send metadata');
            return { ok: false, messageId, objectId };
        }

        const fileBuffer = fs.readFileSync(filePath);
        const ok = await this.sendChunks(objectId, fileBuffer, fileSize, log);

        log?.(
            `[agentthere/file] sent "${fileName}" (${Math.ceil(fileSize / CHUNK_SIZE)} chunks) to ${this.peerId} — ${ok ? 'ok' : 'incomplete'}`
        );
        return { ok, messageId, objectId };
    }

    async sendChunks(objectId, fileBuffer, fileSize, log) {
        let offset = 0;
        while (offset < fileSize) {
            if (!this.isConnected()) {
                log?.(`[agentthere/file] peer ${this.peerId} disconnected at offset ${offset}/${fileSize}`);
                return false;
            }
            const ok = await waitForDrain(this.dc);
            if (!ok) {
                log?.(`[agentthere/file] peer ${this.peerId} drain timeout/closed at offset ${offset}/${fileSize}`);
                return false;
            }
            const end = Math.min(offset + CHUNK_SIZE, fileSize);
            const slice = fileBuffer.subarray(offset, end);
            const base64Data = slice.toString('base64');
            const chunkMsg = JSON.stringify({
                object_id: objectId,
                chunk: { object_id: objectId, offset, data: base64Data }
            });
            if (!this.send(chunkMsg)) {
                log?.(`[agentthere/file] send failed ${this.peerId} offset ${offset}/${fileSize}`);
                return false;
            }
            offset = end;
        }
        return true;
    }

    // ── close ───────────────────────────────────────────────────────────

    close() {
        if (this.stopped) return;
        this.stopped = true;
        if (this.mqtt_client) {
            this.mqtt_client.removeListener('connect', this.on_mqtt_client_connect);
            this.mqtt_client.unsubscribe(`${this.from_remote}/#`);
            this.mqtt_client.removeListener('message', this.on_mqtt_client_message);
            this.mqtt_client = null;
        }
        this.pc?.close();
        this.audioStream?.close();
        this.mediaInPeer?.close();
        this.mediaOutPeer?.close();
        this.dc = null;
        this.connected = false;
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Internal: signaling
    // ══════════════════════════════════════════════════════════════════════

    handleSignaling(topic, msg) {
        const prefix = `${this.from_remote}/`;
        if (!topic.startsWith(prefix)) return;

        let data;
        try {
            data = JSON.parse(msg.toString());
        } catch {
            return;
        }

        const key = topic.slice(prefix.length);
        const tag = data.tag;

        if (key === 'description') {
            const desc = data.description;
            if (!desc?.sdp) return;

            if (tag === 'media:' + this.peerId) {
                if (desc.type === 'offer') {
                    this.mediaMeta = data.meta && typeof data.meta === 'object' ? { ...data.meta } : null;
                    this.audioStream?.setPassthrough?.(this.mediaMeta?.vad_applied === true);
                    this.ensureMediaInPeer(true)
                        .then(mp => mp.setRemoteOffer(desc.sdp))
                        .catch(() => {});
                }
            } else if (tag === 'media:' + this.agent.id) {
                if (desc.type === 'answer') {
                    this.mediaOutPeer?.setRemoteAnswer(desc.sdp);
                }
            } else {
                if (desc.type === 'offer') {
                    this.pc?.setRemoteOffer(desc.sdp);
                } else if (desc.type === 'answer') {
                    this.pc?.setRemoteAnswer(desc.sdp);
                }
            }
        } else if (key === 'candidate') {
            const cand = data.candidate;
            const candidate = typeof cand === 'string' && cand ? cand : (cand?.candidate ?? null);
            const mid = cand && typeof cand === 'object' && cand.sdpMid ? cand.sdpMid : '0';
            if (!candidate) return;

            if (tag === 'media:' + this.peerId) {
                this.mediaInPeer?.addRemoteCandidate(candidate, mid);
            } else if (tag === 'media:' + this.agent.id) {
                this.mediaOutPeer?.addRemoteCandidate(candidate, mid);
            } else {
                this.pc?.addRemoteCandidate(candidate, mid);
            }
        }
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Internal: connection loops
    // ══════════════════════════════════════════════════════════════════════

    startOffererLoop() {
        const BACKOFF = [300, 1000, 3000, 10000, 30000];
        let retries = 0;
        const peerId = this.peerId;
        const label = this.rtc_label;

        (async () => {
            while (!this.stopped) {
                let gate = {};
                try {
                    this.pc = await createPeer({
                        sessionId: randomUUID(),
                        offerer: true,
                        callbacks: {
                            onAnswer: (sdp) => {
                                this.mqtt_client.publish(
                                    `${this.to_remote}/description`,
                                    JSON.stringify({ description: { type: 'answer', sdp } })
                                );
                            },
                            onOffer: (sdp) => {
                                console.log(`[${label}] sending SDP offer to ${peerId}`);
                                this.mqtt_client.publish(
                                    `${this.to_remote}/description`,
                                    JSON.stringify({ description: { type: 'offer', sdp } })
                                );
                            },
                            onCandidate: (c, m) => {
                                this.mqtt_client.publish(
                                    `${this.to_remote}/candidate`,
                                    JSON.stringify({ candidate: { candidate: c, sdpMid: m, sdpMLineIndex: 0 } })
                                );
                            },
                            onDataChannel: (ch) => { this.dc = ch; },
                            onOpen: () => {
                                console.log(`[${label}] DataChannel open with ${peerId}`);
                                this.connected = true;
                                const ok = this.send(JSON.stringify({ type: 'profile', profile: this.agent.profile }));
                                console.log(`[${label}] profile sent to ${peerId}: ${ok}`);
                                if (gate.open) gate.open();
                            },
                            onMessage: (raw) => { this.onRawMessage?.(raw, this); },
                            onClose: () => { if (gate.close) gate.close(new Error('disconnected')); },
                        },
                    });

                    await Promise.race([
                        new Promise(r => { gate.open = r; }),
                        new Promise((_, reject) => {
                            gate.close = reject;
                            setTimeout(() => reject(new Error('timeout')), 25000);
                        }),
                    ]);

                    gate = {};
                    await new Promise(r => { gate.close = r; });

                    retries = 0;
                    this.pc?.close();
                    this.pc = null;
                    const delay = BACKOFF[Math.min(retries, BACKOFF.length - 1)];
                    retries++;
                    console.log(`[${label}] ${peerId} disconnected, retry #${retries} in ${delay}ms`);
                    await new Promise(r => setTimeout(r, delay));
                } catch (e) {
                    if (this.stopped) return;
                    this.pc?.close();
                    this.pc = null;
                    const delay = BACKOFF[Math.min(retries, BACKOFF.length - 1)];
                    retries++;
                    console.log(`[${label}] offer to ${peerId}: ${e.message}, retry #${retries} in ${delay}ms`);
                    await new Promise(r => setTimeout(r, delay));
                }
            }
        })().catch(e => {
            if (!this.stopped) console.error(`[${label}] offerer loop crashed: ${String(e)}`);
        });
    }

    async startNonOfferer() {
        const label = this.rtc_label;
        const peerId = this.peerId;

        this.pc = await createPeer({
            sessionId: randomUUID(),
            offerer: false,
            callbacks: {
                onAnswer: (sdp) => {
                    this.mqtt_client.publish(`${this.to_remote}/description`, JSON.stringify({ description: { type: 'answer', sdp } }));
                },
                onOffer: (sdp) => {
                    this.mqtt_client.publish(`${this.to_remote}/description`, JSON.stringify({ description: { type: 'offer', sdp } }));
                },
                onCandidate: (c, m) => {
                    this.mqtt_client.publish(
                        `${this.to_remote}/candidate`,
                        JSON.stringify({ candidate: { candidate: c, sdpMid: m, sdpMLineIndex: 0 } })
                    );
                },
                onDataChannel: (ch) => { this.dc = ch; },
                onOpen: () => {
                    console.log(`[${label}] DataChannel open with ${peerId}`);
                    this.connected = true;
                    const ok = this.send(JSON.stringify({ type: 'profile', profile: this.agent.profile }));
                    console.log(`[${label}] profile sent to ${peerId}: ${ok}`);
                },
                onMessage: (raw) => { this.onRawMessage?.(raw, this); },
                onClose: () => {
                    console.log(`[${label}] peer disconnected: ${peerId}`);
                },
            },
        });
    }

    // ══════════════════════════════════════════════════════════════════════
    //  Internal: media peers
    // ══════════════════════════════════════════════════════════════════════

    async ensureMediaInPeer(forceRecreate = false) {
        const peerId = this.peerId;
        const label = this.rtc_label;

        if (this.pendingMediaIn) {
            try { await this.pendingMediaIn; } catch {}
        }

        if (this.mediaInPeer) {
            if (!forceRecreate) return this.mediaInPeer;
            const oldPeer = this.mediaInPeer;
            this.mediaInPeer = null;
            setImmediate(() => { try { oldPeer.close(); } catch {} });
        }

        let createdPeer = null;
        const promise = (async () => {
            createdPeer = await createMediaInPeer({
                sessionId: randomUUID(),
                callbacks: {
                    onAnswer: (sdp) => {
                        this.mqtt_client.publish(
                            `${this.to_remote}/description`,
                            JSON.stringify({ tag: `media:${peerId}`, description: { type: 'answer', sdp } })
                        );
                    },
                    onCandidate: (candidate, mid) => {
                        this.mqtt_client.publish(
                            `${this.to_remote}/candidate`,
                            JSON.stringify({ tag: `media:${peerId}`, candidate: { candidate, sdpMid: mid, sdpMLineIndex: 0 } })
                        );
                    },
                    onTrack: (track) => {
                        if (this.audioStream && !this.audioStream._closed) {
                            const p = this.mediaMeta?.vad_applied === true;
                            this.audioStream.setPassthrough?.(p);
                            track.onMessage(msg => this.audioStream.push(msg));
                            track.onClosed(() => {});
                        } else {
                            const p = this.mediaMeta?.vad_applied === true;
                            const handle = new VADAudioTrackHandle({ passthrough: p });
                            this.audioStream = handle;
                            track.onMessage(msg => handle.push(msg));
                            track.onClosed(() => {});
                            (async () => {
                                const deadline = Date.now() + 2000;
                                while (!this.uid && Date.now() < deadline) {
                                    await new Promise(r => setTimeout(r, 50));
                                }
                                if (!this.uid) console.warn(`[${label}] inbound stream from ${peerId}: uid not received within 2s`);
                                this.onInboundStream?.(handle, this);
                            })();
                        }
                    },
                    onClose: () => {
                        if (this.mediaInPeer === createdPeer) this.mediaInPeer = null;
                    },
                },
            });
            return createdPeer;
        })();

        this.pendingMediaIn = promise;
        try {
            const peer = await promise;
            this.mediaInPeer = peer;
            return peer;
        } finally {
            if (this.pendingMediaIn === promise) this.pendingMediaIn = null;
        }
    }

    async ensureMediaOutPeer() {
        if (this.mediaOutPeer) return this.mediaOutPeer;

        this.mediaOutPeer = await createMediaOutPeer({
            sessionId: randomUUID(),
            callbacks: {
                onOffer: (sdp) => {
                    this.mqtt_client.publish(
                        `${this.to_remote}/description`,
                        JSON.stringify({ tag: `media:${this.agent.id}`, description: { type: 'offer', sdp } })
                    );
                },
                onCandidate: (candidate, mid) => {
                    this.mqtt_client.publish(
                        `${this.to_remote}/candidate`,
                        JSON.stringify({ tag: `media:${this.agent.id}`, candidate: { candidate, sdpMid: mid, sdpMLineIndex: 0 } })
                    );
                },
                onClose: () => { this.mediaOutPeer = null; },
            },
        });

        return this.mediaOutPeer;
    }
}
