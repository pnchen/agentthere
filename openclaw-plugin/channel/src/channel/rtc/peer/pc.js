/**
 * AgentThere PC wrapper using node-datachannel.
 *
 * Creates a server-side RTCPeerConnection that:
 *  1. Receives an SDP offer from a browser client via signaling (MQTT)
 *  2. Generates an SDP answer + local ICE candidates
 *  3. Opens a DataChannel for bidirectional text messaging
 *
 * ICE traversal path (in preference order):
 *   - Direct (same LAN / public IP)
 *   - STUN coordinate → hole punch through NAT
 *   - TURN relay (fallback for symmetric NAT)
 *
 * Media peers (createMediaPeer) add an Opus audio track on a
 * separate PeerConnection so voice calls coexist with the text
 * DataChannel without SDP renegotiation.
 *
 * This module is a pure WebRTC wrapper. Session bookkeeping and
 * DataChannel reference tracking belong to the caller.
 */

// Lazy import so the native binary is only loaded when actually needed.
let ndc;

async function getNdc() {
    if (!ndc) {
        ndc = await import('node-datachannel');
    }
    return ndc;
}

import { getRuntime } from '../../../runtime.js';

/** ICE servers from openclaw config — direct read, no fallback. */
function readIceServers() {
    return getRuntime().config?.current()?.channels?.agentthere?.ice_servers || [];
}

/**
 * Convert openclaw ICE server config objects to node-datachannel URL format.
 * TURN servers with credentials become turn:user:cred@host:port.
 */
function formatIceServers(iceServers) {
    return iceServers.flatMap(srv => {
        const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
        return urls.map(url => {
            if (srv.username && srv.credential) {
                const match = url.match(/^(turns?):(.*)$/);
                if (match) {
                    return `${match[1]}:${srv.username}:${srv.credential}@${match[2]}`;
                }
            }
            return url;
        });
    });
}

// ── shared DataChannel event wiring ────────────────────────────────────────────

function wireDataChannel(dc, { sessionId, onOpen, onClose, onMessage }) {
    dc.onOpen(() => {
        console.log(`[${sessionId}] DataChannel open`);
        onOpen?.();
    });

    dc.onClosed(() => {
        console.log(`[${sessionId}] DataChannel closed`);
        onClose?.();
    });

    dc.onError(err => {
        console.error(`[${sessionId}] DataChannel error: ${err}`);
    });

    dc.onMessage(msg => {
        const text = typeof msg === 'string' ? msg : Buffer.from(msg).toString();
        onMessage(text);
    });
}

// ── data peer ──────────────────────────────────────────────────────────────────

export async function createPeer(params) {
    const { sessionId, callbacks, offerer = false } = params;
    const lib = await getNdc();

    const iceServers = readIceServers();
    const pc = new lib.PeerConnection(sessionId, {
        iceServers: formatIceServers(iceServers)
    });

    let dc = null;
    let closed = false;
    let _closeResolve;
    let _connectionState = 'new';

    const doClose = () => {
        if (closed) return;
        closed = true;
        try {
            dc?.close();
        } catch {
            /* ignore */
        }
        try {
            pc.close();
        } catch {
            /* ignore */
        }
        _closeResolve?.();
        callbacks.onClose();
    };

    pc.onLocalDescription((sdp, type) => {
        if (type === 'answer') {
            console.log(`[${sessionId}] generated SDP answer`);
            callbacks.onAnswer(sdp);
        } else if (type === 'offer') {
            console.log(`[${sessionId}] generated SDP offer`);
            callbacks.onOffer?.(sdp);
        }
    });

    pc.onLocalCandidate((candidate, mid) => {
        console.log(`[${sessionId}] local candidate mid=${mid}`);
        callbacks.onCandidate(candidate, mid);
    });

    pc.onStateChange(state => {
        _connectionState = state;
        console.log(`[${sessionId}] connection state: ${state}`);
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
            doClose();
        }
    });

    // DataChannel opened by the browser (offerer creates it, answerer receives it).
    pc.onDataChannel(channel => {
        const label =
            typeof channel.getLabel === 'function' ? channel.getLabel() : typeof channel.label === 'function' ? channel.label() : 'unknown';
        console.log(`[${sessionId}] DataChannel received: ${label}`);
        dc = channel;
        callbacks.onDataChannel?.(channel);
        wireDataChannel(channel, {
            sessionId,
            onOpen: () => callbacks.onOpen(),
            onClose: () => doClose(),
            onMessage: text => callbacks.onMessage(text)
        });
    });

    // Only the offerer side creates a DataChannel (triggers SDP offer).
    if (offerer) {
        console.log(`[${sessionId}] creating agent-initiated DataChannel to trigger offer`);
        const agentDc = pc.createDataChannel('agent-message');
        callbacks.onDataChannel?.(agentDc);
        wireDataChannel(agentDc, {
            sessionId,
            onOpen: () => {
                if (!dc) {
                    dc = agentDc;
                    callbacks.onOpen();
                }
            },
            onClose: () => {
                console.log(`[${sessionId}] agent-initiated DataChannel closed`);
            },
            onMessage: text => callbacks.onMessage(text)
        });
    }

    return {
        setRemoteOffer(sdp) {
            if (closed) return;
            try {
                pc.setRemoteDescription(sdp, 'offer');
            } catch (err) {
                console.error(`[${sessionId}] setRemoteOffer failed (possible collision): ${String(err)}`);
            }
        },
        setRemoteAnswer(sdp) {
            if (closed) return;
            try {
                pc.setRemoteDescription(sdp, 'answer');
            } catch (err) {
                console.error(`[${sessionId}] setRemoteAnswer failed: ${String(err)}`);
            }
        },
        addRemoteCandidate(candidate, mid) {
            if (closed) return;
            try {
                pc.addRemoteCandidate(candidate, mid);
            } catch (err) {
                console.error(`[${sessionId}] addRemoteCandidate failed: ${String(err)}`);
            }
        },
        /** Roll back a pending local offer — used during offer collision (polite side). */
        rollbackLocal() {
            if (closed) return;
            try {
                pc.setLocalDescription('rollback');
                console.log(`[${sessionId}] local description rolled back`);
            } catch (err) {
                console.error(`[${sessionId}] rollbackLocal failed: ${String(err)}`);
                doClose();
            }
        },
        closed: new Promise(resolve => { _closeResolve = resolve; }),
        close: doClose,
        getConnectionState: () => _connectionState
    };
}

// ── media peer (audio track) ────────────────────────────────────────────────────

// Internal helper — use createMediaOutPeer / createMediaInPeer instead.
async function createMediaPeer(params) {
    const { sessionId, direction, callbacks, initiateOffer = true } = params;
    const lib = await getNdc();

    const iceServers = readIceServers();

    // Normalise to PascalCase as expected by node-datachannel.
    const _dirMap = { sendonly: 'SendOnly', recvonly: 'RecvOnly', sendrecv: 'SendRecv' };
    const dir = _dirMap[direction.toLowerCase()] ?? direction;
    const isSender = dir === 'SendOnly' || dir === 'SendRecv';

    const pc = new lib.PeerConnection(`media-${sessionId}`, {
        iceServers: formatIceServers(iceServers)
    });

    let closed = false;
    let audioTrack = null;
    const remoteTracks = new Set();

    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    // Avoid unhandled-rejection if nobody awaits ready and the peer closes early.
    ready.catch(() => {});

    const doClose = () => {
        if (closed) return;
        closed = true;
        readyReject(new Error('media peer closed before ready'));
        try {
            audioTrack?.close();
        } catch {
            /* ignore */
        }
        for (const track of remoteTracks) {
            try {
                track.close();
            } catch {
                /* ignore */
            }
        }
        remoteTracks.clear();
        try {
            pc.close();
        } catch {
            /* ignore */
        }
        callbacks.onClose?.();
    };

    pc.onLocalDescription((sdp, type) => {
        if (type === 'offer') {
            console.log(`[media-${sessionId}] generated SDP offer (direction=${dir})`);
            callbacks.onOffer?.(sdp);
        } else if (type === 'answer') {
            console.log(`[media-${sessionId}] generated SDP answer`);
            callbacks.onAnswer?.(sdp);
        }
    });

    pc.onLocalCandidate((candidate, mid) => {
        callbacks.onCandidate?.(candidate, mid);
    });

    pc.onStateChange(state => {
        console.log(`[media-${sessionId}] connection state: ${state}`);
        if (state === 'connected') {
            readyResolve();
        }
        if (state === 'disconnected' || state === 'failed' || state === 'closed') {
            doClose();
        }
    });

    // Remote audio track — pass raw node-datachannel Track to monitor.
    // Drop non-audio tracks at the peer boundary so downstream code only sees audio.
    pc.onTrack(track => {
        const trackType = typeof track.type === 'function' ? track.type() : 'unknown';
        if (trackType !== 'audio') {
            console.log(`[media-${sessionId}] ignoring remote ${trackType} track mid=${track.mid()}`);
            try {
                track.close();
            } catch {
                /* ignore */
            }
            return;
        }

        remoteTracks.add(track);
        console.log(`[media-${sessionId}] remote audio track received mid=${track.mid()}`);
        callbacks.onTrack?.(track);
        track.onClosed(() => {
            remoteTracks.delete(track);
            console.log(`[media-${sessionId}] remote audio track closed`);
        });
    });

    if (isSender) {
        const audio = new lib.Audio('audio', dir);
        audio.addOpusCodec(111);
        audioTrack = pc.addTrack(audio);
        if (initiateOffer) {
            // Trigger SDP offer generation — callbacks are already registered.
            pc.setLocalDescription();
        }
    }

    return {
        setRemoteOffer(sdp) {
            if (closed) return;
            try {
                pc.setRemoteDescription(sdp, 'offer');
            } catch (err) {
                console.error(`[media-${sessionId}] setRemoteOffer failed: ${String(err)}`);
            }
        },
        setRemoteAnswer(sdp) {
            if (closed) return;
            try {
                pc.setRemoteDescription(sdp, 'answer');
            } catch (err) {
                console.error(`[media-${sessionId}] setRemoteAnswer failed: ${String(err)}`);
            }
        },
        addRemoteCandidate(candidate, mid) {
            if (closed) return;
            try {
                pc.addRemoteCandidate(candidate, mid);
            } catch (err) {
                console.error(`[media-${sessionId}] addRemoteCandidate failed: ${String(err)}`);
            }
        },
        /** Send an Opus-encoded audio frame to the remote peer. */
        sendAudioFrame(opusFrame) {
            if (closed || !audioTrack) return;
            try {
                audioTrack.sendMessageBinary(opusFrame);
            } catch (err) {
                console.error(`[media-${sessionId}] sendAudioFrame error: ${String(err)}`);
            }
        },
        /** Resolves once the peer is connected and audio frames can be sent. */
        ready,
        close: doClose
    };
}

/** Send-only media peer — AgentThere sends TTS audio to browser. */
export function createMediaOutPeer(params) {
    return createMediaPeer({ ...params, direction: 'sendonly' });
}

/** Receive-only media peer — AgentThere receives browser audio. */
export function createMediaInPeer(params) {
    return createMediaPeer({ ...params, direction: 'recvonly' });
}
