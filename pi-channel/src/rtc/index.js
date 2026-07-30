/**
 * MQTT-based RTC orchestrator for the AgentThere channel.
 *
 * Adapted from openclaw-plugin/channel/src/channel/rtc/index.js
 * Replaced getRuntime() config reads with injected iceServers + namespace.
 */
import { randomUUID } from "node:crypto";
import { Peer, hashId } from "./peer/index.js";

// ── process registries (exported for consumers) ─────────────────────────
const _peers = new Map();
const _groups = new Map();

export function registerGroup(group) {
    _groups.set(group.groupId, group);
}

export function unregisterGroup(groupId) {
    _groups.delete(groupId);
}

export function getGroup(groupId) {
    return _groups.get(groupId) || null;
}

export function getGroups() {
    return [..._groups.values()];
}

export function getPeers() {
    return _peers;
}

export function getPeer(groupId, peerId) {
    return _peers.get(`${groupId}.${peerId}`) || null;
}

export function getPeerByPeerId(peerId) {
    return [..._peers.values()].find((p) => p.peerId === peerId) ?? null;
}

export function getGroupPeers(groupId) {
    return [..._peers.values()].filter((p) =>
        p.sessionMode === "group" &&
        p.groupId === groupId &&
        p.connected &&
        p.dc
    );
}

export async function startGroupMonitor(opts) {
    const { client, groupId, agentPeerId, namespace, iceServers } = opts;
    const rtcLabel = `agentthere/rtc:${groupId}`;

    const profile = opts.profile || { agent: true };
    profile.agent = true;

    let _onInboundStream = null;
    let _onRawMessage = null;

    let stopped = false;

    const hGroup = hashId(groupId);
    const hAgent = hashId(agentPeerId);
    const ns = (path) => namespace ? `${namespace}/${path}` : path;
    const queryTopic = ns(`${hGroup}/query`);
    const answerTopic = ns(`${hGroup}/${hAgent}/answer`);
    const byeTopic = ns(`${hGroup}/bye`);
    const willTopic = ns(`${hGroup}/will`);

    const key = (peerId) => `${groupId}.${peerId}`;

    function _removePeer(peerId) {
        const k = key(peerId);
        const peer = _peers.get(k);
        if (!peer) return;
        console.log(`[${rtcLabel}] removing peer ${peerId} (${peer.peerName})`);
        peer.close();
        _peers.delete(k);
    }

    function _markPeerLost(peerId) {
        const peer = _peers.get(key(peerId));
        if (!peer || peer.lost_at) return;
        peer.lost_at = Date.now();
        console.log(`[${rtcLabel}] peer ${peerId} (${peer.peerName}) lost, will remove in 10s`);
    }

    function _revivePeer(peerId) {
        const peer = _peers.get(key(peerId));
        if (!peer?.lost_at) return;
        delete peer.lost_at;
        console.log(`[${rtcLabel}] peer ${peerId} revived`);
    }

    const _sweepInterval = setInterval(() => {
        if (stopped) return;
        const now = Date.now();
        for (const [, peer] of _peers) {
            if (peer.groupId !== groupId) continue;
            if (peer.lost_at && now - peer.lost_at > 10000) {
                console.log(`[${rtcLabel}] peer ${peer.peerId} lost expired, removing`);
                _removePeer(peer.peerId);
            }
        }
    }, 2000);

    const connectPeer = async (peerId, reason) => {
        if (stopped) return;
        const k = key(peerId);
        if (_peers.has(k)) {
            const peer = _peers.get(k);
            if (peer.lost_at) {
                delete peer.lost_at;
                console.log(`[${rtcLabel}] peer ${peerId} revived on re-detection (${reason})`);
            }
            return;
        }

        console.log(`[${rtcLabel}] new peer detected: ${peerId} (${reason})`);

        const peer = new Peer({
            peerId,
            agent: { id: agentPeerId, profile },
            groupId,
            namespace,
            iceServers,
            onRawMessage: (raw, p) => {
                Promise.resolve(_onRawMessage?.(raw, p)).catch((error) => {
                    console.error(`[${rtcLabel}] raw message handler failed: ${String(error)}`);
                });
            },
            onInboundStream: (handle, p) => {
                Promise.resolve(_onInboundStream?.(handle, p)).catch((error) => {
                    console.error(`[${rtcLabel}] inbound stream handler failed: ${String(error)}`);
                });
            },
        });

        _peers.set(k, peer);
        opts.onPeer?.(peer, groupId);
        peer.connect(client);
    };

    function on_mqtt_client_connect() {
        if (stopped) return;
        console.log(`[${rtcLabel}] MQTT connected as "${profile.name}" (${agentPeerId})`);
        console.log(`[${rtcLabel}] topics: query=${queryTopic} answer=${answerTopic} bye=${byeTopic} will=${willTopic}`);

        const subs = [queryTopic, answerTopic, byeTopic, willTopic];
        for (const topic of subs) {
            client.subscribe(topic, (err) => {
                if (err) console.error(`[${rtcLabel}] subscribe failed ${topic}: ${String(err)}`);
            });
        }

        client.publish(queryTopic, JSON.stringify({ answer_to: answerTopic, id: agentPeerId, agent: true }));
    }

    client.on("connect", on_mqtt_client_connect);
    on_mqtt_client_connect();

    async function on_mqtt_client_message(mqttTopic, payload) {
        if (stopped) return;

        let data;
        try {
            data = JSON.parse(payload.toString());
        }
        catch {
            return;
        }

        if (mqttTopic === queryTopic) {
            const peerId = data.id;
            if (!data.answer_to || !peerId || peerId === agentPeerId || data.answer_to === answerTopic) return;
            _revivePeer(peerId);
            client.publish(data.answer_to, JSON.stringify({ id: agentPeerId, agent: true }));
            connectPeer(peerId, "query").catch((err) => {
                console.error(`[${rtcLabel}] connectPeer(query) failed: ${String(err)}`);
            });
            return;
        }

        if (mqttTopic === answerTopic) {
            const peerId = data.id;
            if (!peerId || peerId === agentPeerId) return;
            _revivePeer(peerId);
            connectPeer(peerId, "answer").catch((err) => {
                console.error(`[${rtcLabel}] connectPeer(answer) failed: ${String(err)}`);
            });
            return;
        }

        if (mqttTopic === byeTopic) {
            const byeId = data.id;
            if (!byeId || byeId === agentPeerId) return;
            console.log(`[${rtcLabel}] BYE from ${byeId}`);
            _removePeer(byeId);
            return;
        }

        if (mqttTopic === willTopic) {
            const willId = data.id;
            if (!willId || willId === agentPeerId) return;
            _markPeerLost(willId);
            return;
        }
    }

    client.on("message", on_mqtt_client_message);

    if (opts.abortSignal) {
        opts.abortSignal.addEventListener("abort", () => cleanup());
    }

    function cleanup() {
        if (stopped) return;
        stopped = true;
        clearInterval(_sweepInterval);
        client.publish(byeTopic, JSON.stringify({ id: agentPeerId }), { qos: 0, retain: false });
        for (const [k, peer] of _peers) {
            if (peer.groupId === groupId) {
                peer.close();
                _peers.delete(k);
            }
        }
        client.removeListener("connect", on_mqtt_client_connect);
        client.removeListener("message", on_mqtt_client_message);
    }

    return {
        cleanup,
        setOnInboundStream: (cb) => {
            _onInboundStream = cb;
        },
        setOnRawMessage: (cb) => {
            _onRawMessage = cb;
        },
        getPeerIds: () => [..._peers.values()].filter((p) => p.groupId === groupId).map((p) => p.peerId),
        getPeers: () => [..._peers.values()].filter((p) => p.groupId === groupId),
        broadcastProfile: () => {
            for (const peer of _peers.values()) {
                if (peer.groupId !== groupId) continue;
                peer.agent.profile = { ...profile };
                peer.send(JSON.stringify({ type: "profile", profile }));
            }
        },
    };
}
