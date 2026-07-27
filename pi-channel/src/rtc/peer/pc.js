/**
 * AgentThere PC wrapper using node-datachannel.
 *
 * Adapted from openclaw-plugin/channel/src/channel/rtc/peer/pc.js
 * Replaced getRuntime() config reads with direct iceServers parameter.
 */

// Lazy import so the native binary is only loaded when actually needed.
let ndc;

async function getNdc() {
    if (!ndc) {
        ndc = await import("node-datachannel");
    }
    return ndc;
}

/**
 * Convert openclaw ICE server config objects to node-datachannel URL format.
 * TURN servers with credentials become turn:user:cred@host:port.
 */
function formatIceServers(iceServers) {
    return iceServers.flatMap((srv) => {
        const urls = Array.isArray(srv.urls) ? srv.urls : [srv.urls];
        return urls.map((url) => {
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

    dc.onError((err) => {
        console.error(`[${sessionId}] DataChannel error: ${err}`);
    });

    dc.onMessage((msg) => {
        const text = typeof msg === "string" ? msg : Buffer.from(msg).toString();
        onMessage(text);
    });
}

// ── data peer ──────────────────────────────────────────────────────────────────

export async function createPeer(params) {
    const { sessionId, callbacks, offerer = false, iceServers } = params;
    const lib = await getNdc();

    const pc = new lib.PeerConnection(sessionId, {
        iceServers: formatIceServers(iceServers),
    });

    let dc = null;
    let closed = false;
    let _closeResolve;
    let _connectionState = "new";

    const doClose = (reason = "unknown") => {
        if (closed) return;
        console.log(`[${sessionId}] doClose reason=${reason}`);
        closed = true;
        try {
            dc?.close();
        }
        catch {
            /* ignore */
        }
        try {
            pc.close();
        }
        catch {
            /* ignore */
        }
        _closeResolve?.();
        callbacks.onClose();
    };

    pc.onLocalDescription((sdp, type) => {
        const hasDc = sdp.includes("m=application");
        if (type === "answer") {
            console.log(`[${sessionId}] generated SDP answer hasDataChannel=${hasDc}`);
            callbacks.onAnswer(sdp);
        }
        else if (type === "offer") {
            console.log(`[${sessionId}] generated SDP offer hasDataChannel=${hasDc}`);
            callbacks.onOffer?.(sdp);
        }
    });

    pc.onLocalCandidate((candidate, mid) => {
        console.log(`[${sessionId}] local candidate mid=${mid}`);
        callbacks.onCandidate(candidate, mid);
    });

    pc.onStateChange((state) => {
        _connectionState = state;
        console.log(`[${sessionId}] connection state: ${state}`);
        if (state === "disconnected" || state === "failed" || state === "closed") {
            doClose(`state:${state}`);
        }
    });

    pc.onDataChannel((channel) => {
        const label =
            typeof channel.getLabel === "function" ? channel.getLabel() : typeof channel.label === "function" ? channel.label() : "unknown";
        console.log(`[${sessionId}] DataChannel received: ${label}`);
        dc = channel;
        callbacks.onDataChannel?.(channel);
        wireDataChannel(channel, {
            sessionId,
            onOpen: () => {
                console.log(`[${sessionId}] remote DataChannel onOpen fired`);
                callbacks.onOpen();
            },
            onClose: () => doClose("remote-dc-closed"),
            onMessage: (text) => callbacks.onMessage(text),
        });
    });

    if (offerer) {
        console.log(`[${sessionId}] creating agent-initiated DataChannel to trigger offer`);
        const agentDc = pc.createDataChannel("agent-message");
        callbacks.onDataChannel?.(agentDc);
        wireDataChannel(agentDc, {
            sessionId,
            onOpen: () => {
                console.log(`[${sessionId}] agent-initiated DataChannel onOpen fired`);
                if (!dc) {
                    dc = agentDc;
                    callbacks.onOpen();
                }
            },
            onClose: () => {
                console.log(`[${sessionId}] agent-initiated DataChannel closed`);
                doClose("agent-dc-closed");
            },
            onMessage: (text) => callbacks.onMessage(text),
        });
    }

    return {
        setRemoteOffer(sdp) {
            if (closed) return;
            try {
                console.log(`[${sessionId}] setRemoteDescription(offer)`);
                pc.setRemoteDescription(sdp, "offer");
            }
            catch (err) {
                console.error(`[${sessionId}] setRemoteOffer failed (possible collision): ${String(err)}`);
            }
        },
        setRemoteAnswer(sdp) {
            if (closed) return;
            try {
                console.log(`[${sessionId}] setRemoteDescription(answer)`);
                pc.setRemoteDescription(sdp, "answer");
            }
            catch (err) {
                console.error(`[${sessionId}] setRemoteAnswer failed: ${String(err)}`);
            }
        },
        addRemoteCandidate(candidate, mid) {
            if (closed) return;
            try {
                pc.addRemoteCandidate(candidate, mid);
            }
            catch (err) {
                console.error(`[${sessionId}] addRemoteCandidate failed: ${String(err)}`);
            }
        },
        rollbackLocal() {
            if (closed) return;
            try {
                pc.setLocalDescription("rollback");
                console.log(`[${sessionId}] local description rolled back`);
            }
            catch (err) {
                console.error(`[${sessionId}] rollbackLocal failed: ${String(err)}`);
                doClose("rollback-failed");
            }
        },
        closed: new Promise((resolve) => { _closeResolve = resolve; }),
        close: doClose,
        getConnectionState: () => _connectionState,
    };
}

// ── media peer (audio track) ────────────────────────────────────────────────────

async function createMediaPeer(params) {
    const {
        sessionId,
        direction,
        callbacks,
        initiateOffer = true,
        iceServers,
        mediaKind = "audio",
        videoBitrate = 3000,
    } = params;
    console.log(`[media-${sessionId}] createMediaPeer direction=${direction} iceServers=${iceServers?.length ?? 0}`);
    const lib = await getNdc();

    const _dirMap = { sendonly: "SendOnly", recvonly: "RecvOnly", sendrecv: "SendRecv" };
    const dir = _dirMap[direction.toLowerCase()] ?? direction;
    const isSender = dir === "SendOnly" || dir === "SendRecv";

    const pc = new lib.PeerConnection(`media-${sessionId}`, {
        iceServers: formatIceServers(iceServers),
    });

    let closed = false;
    let audioTrack = null;
    let videoTrack = null;
    let videoRtpConfig = null;
    const remoteTracks = new Set();

    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => {
        readyResolve = resolve;
        readyReject = reject;
    });
    ready.catch(() => { });
    let trackReadyResolve;
    let trackReadyReject;
    const trackReady = new Promise((resolve, reject) => {
        trackReadyResolve = resolve;
        trackReadyReject = reject;
    });
    trackReady.catch(() => { });

    const doClose = (reason = "unknown") => {
        if (closed) return;
        console.log(`[media-${sessionId}] doClose reason=${reason}`);
        closed = true;
        const closeError = new Error("media peer closed before ready");
        readyReject(closeError);
        trackReadyReject(closeError);
        try {
            audioTrack?.close();
            videoTrack?.close();
        }
        catch {
            /* ignore */
        }
        for (const track of remoteTracks) {
            try {
                track.close();
            }
            catch {
                /* ignore */
            }
        }
        remoteTracks.clear();
        try {
            pc.close();
        }
        catch {
            /* ignore */
        }
        callbacks.onClose?.();
    };

    pc.onLocalDescription((sdp, type) => {
        if (type === "offer") {
            console.log(`[media-${sessionId}] generated SDP offer (direction=${dir})`);
            callbacks.onOffer?.(sdp);
        }
        else if (type === "answer") {
            console.log(`[media-${sessionId}] generated SDP answer`);
            callbacks.onAnswer?.(sdp);
        }
    });

    pc.onLocalCandidate((candidate, mid) => {
        callbacks.onCandidate?.(candidate, mid);
    });

    pc.onStateChange((state) => {
        console.log(`[media-${sessionId}] connection state: ${state}`);
        if (state === "connected") {
            readyResolve();
        }
        if (state === "disconnected" || state === "failed" || state === "closed") {
            doClose(`state:${state}`);
        }
    });

    pc.onTrack((track) => {
        const trackType = typeof track.type === "function" ? track.type() : "unknown";
        if (trackType !== "audio") {
            console.log(`[media-${sessionId}] ignoring remote ${trackType} track mid=${track.mid()}`);
            try {
                track.close();
            }
            catch {
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
        if (mediaKind === "audio" || mediaKind === "av") {
            const audio = new lib.Audio("audio", dir);
            audio.addOpusCodec(111);
            audioTrack = pc.addTrack(audio);
        }
        if (mediaKind === "video" || mediaKind === "av") {
            const video = new lib.Video("video", dir);
            video.addH264Codec(96);
            video.setBitrate(videoBitrate);
            videoTrack = pc.addTrack(video);
            videoTrack.onOpen(() => {
                console.log(`[media-${sessionId}] video track open`);
                trackReadyResolve();
            });
            videoTrack.onClosed(() => {
                trackReadyReject(new Error("video track closed"));
            });
            videoRtpConfig = new lib.RtpPacketizationConfig(
                (Math.random() * 0xffffffff) >>> 0,
                "agentthere-video",
                96,
                90000,
            );
            const packetizer = new lib.H264RtpPacketizer("StartSequence", videoRtpConfig);
            videoTrack.setMediaHandler(packetizer);
        }
        if (initiateOffer) {
            pc.setLocalDescription();
        }
    }

    return {
        id: sessionId,
        setRemoteOffer(sdp) {
            if (closed) {
                console.log(`[media-${sessionId}] setRemoteOffer after closed`);
                return;
            }
            try {
                pc.setRemoteDescription(sdp, "offer");
            }
            catch (err) {
                console.error(`[media-${sessionId}] setRemoteOffer failed: ${String(err)}`);
            }
        },
        setRemoteAnswer(sdp) {
            if (closed) return;
            try {
                pc.setRemoteDescription(sdp, "answer");
            }
            catch (err) {
                console.error(`[media-${sessionId}] setRemoteAnswer failed: ${String(err)}`);
            }
        },
        addRemoteCandidate(candidate, mid) {
            if (closed) return;
            try {
                pc.addRemoteCandidate(candidate, mid);
            }
            catch (err) {
                console.error(`[media-${sessionId}] addRemoteCandidate failed: ${String(err)}`);
            }
        },
        sendAudioFrame(opusFrame) {
            if (closed || !audioTrack) return false;
            try {
                return audioTrack.sendMessageBinary(opusFrame);
            }
            catch (err) {
                console.error(`[media-${sessionId}] sendAudioFrame error: ${String(err)}`);
                return false;
            }
        },
        sendVideoFrame(h264Frame, timestamp) {
            if (closed || !videoTrack || !videoRtpConfig) return false;
            try {
                videoRtpConfig.timestamp = timestamp >>> 0;
                return videoTrack.sendMessageBinary(h264Frame);
            }
            catch (err) {
                console.error(`[media-${sessionId}] sendVideoFrame error: ${String(err)}`);
                return false;
            }
        },
        ready: mediaKind === "video" || mediaKind === "av" ? Promise.all([ready, trackReady]) : ready,
        close: doClose,
    };
}

export function createMediaOutPeer(params) {
    return createMediaPeer({ ...params, direction: "sendonly", mediaKind: "audio" });
}

export function createMediaVideoOutPeer(params) {
    return createMediaPeer({ ...params, direction: "sendonly", mediaKind: "video" });
}

export function createMediaTaskOutPeer(params) {
    return createMediaPeer({
        ...params,
        direction: "sendonly",
        mediaKind: params.mediaKind ?? "av",
    });
}

export function createMediaInPeer(params) {
    return createMediaPeer({ ...params, direction: "recvonly" });
}
