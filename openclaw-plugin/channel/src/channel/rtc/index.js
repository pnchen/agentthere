/**
 * MQTT-based RTC orchestrator for the AgentThere channel.
 *
 * Responsibilities:
 *   - MQTT connection lifecycle (connect / reconnect / will)
 *   - Peer discovery via query/answer (mDNS-style)
 *   - Peer lifecycle (create / teardown — delegates connection to Peer class)
 *   - Lost-peer tracking (will / sweep)
 */

import { randomUUID } from 'node:crypto';
import { getRuntime } from '../../runtime.js';
import { Peer, hashId } from './peer/index.js';

// ── peer registry (exported for consumers) ────────────────────────────────────
//
// Shared across all group monitors. Keys are "groupId.peerId".

const _peers = new Map();

export function getPeers() {
    return _peers;
}

export function getPeerByPeerId(peerId) {
    return [..._peers.values()].find(p => p.peerId === peerId) ?? null;
}

export function getGroupPeers(groupId) {
    return [..._peers.values()].filter(p => p.sessionMode === 'group' && p.groupId === groupId && p.connected && p.dc);
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Join a named group as an agent peer.
 */
export async function startGroupMonitor(opts) {
    const { client, groupId, agentId } = opts;
    const rtcLabel = `agentthere/rtc:${groupId}`;

    const buildAgentProfile = () => ({ ...opts.identity(), agent: true });

    // ── callbacks ────────────────────────────────────────────────────────

    let _onInboundStream = null;
    let _onRawMessage = null;

    // ── MQTT ─────────────────────────────────────────────────────────────

    let stopped = false;

    const hGroup = hashId(groupId);
    const hAgent = hashId(agentId);
    const ns = path => {
        const namespace = getRuntime().config?.current()?.channels?.agentthere?.mqtt?.namespace || '';
        return namespace ? `${namespace}/${path}` : path;
    };
    const queryTopic = ns(`${hGroup}/query`);
    const answerTopic = ns(`${hGroup}/${hAgent}/answer`);
    const byeTopic = ns(`${hGroup}/bye`);
    const willTopic = ns(`${hGroup}/will`);

    // ── peer lifecycle ───────────────────────────────────────────────────

    const key = peerId => `${groupId}.${peerId}`;

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

    // ── connectPeer ──────────────────────────────────────────────────────

    const connectPeer = async peerId => {
        if (stopped) return;
        const k = key(peerId);
        if (_peers.has(k)) {
            const peer = _peers.get(k);
            if (peer.lost_at) {
                delete peer.lost_at;
                console.log(`[${rtcLabel}] peer ${peerId} revived on re-detection`);
            }
            return;
        }

        console.log(`[${rtcLabel}] new peer detected: ${peerId}`);

        const profile = buildAgentProfile();
        const peer = new Peer({
            peerId,
            agent: { id: agentId, profile },
            groupId,
            onRawMessage: (raw, peer) => _onRawMessage?.(raw, peer),
            onInboundStream: (handle, peer) => _onInboundStream?.(handle, peer)
        });

        _peers.set(k, peer);
        peer.connect(client);
    };

    // ── MQTT event handlers ──────────────────────────────────────────────

    function on_mqtt_client_connect() {
        if (stopped) return;
        console.log(`[${rtcLabel}] MQTT connected as "${opts.identity()?.name}" (${agentId})`);

        client.subscribe(queryTopic);
        client.subscribe(answerTopic);
        client.subscribe(byeTopic);
        client.subscribe(willTopic);

        const queryPayload = JSON.stringify({ answer_to: answerTopic, id: agentId, agent: true });
        client.publish(queryTopic, queryPayload);
    }

    client.on('connect', on_mqtt_client_connect);
    on_mqtt_client_connect();

    async function on_mqtt_client_message(mqttTopic, payload) {
        if (stopped) return;

        let data;
        try {
            data = JSON.parse(payload.toString());
        } catch {
            return;
        }

        if (mqttTopic === queryTopic) {
            const answerTo = data.answer_to;
            const peerId = data.id;
            if (!answerTo || !peerId || peerId === agentId || answerTo === answerTopic) return;
            _revivePeer(peerId);
            client.publish(answerTo, JSON.stringify({ id: agentId, agent: true }));
            await new Promise(r => setTimeout(r, 1000));
            connectPeer(peerId).catch(err => {
                console.error(`[${rtcLabel}] connectPeer(query) failed: ${String(err)}`);
            });
            return;
        }

        if (mqttTopic === answerTopic) {
            const peerId = data.id;
            if (!peerId || peerId === agentId) return;
            _revivePeer(peerId);
            connectPeer(peerId).catch(err => {
                console.error(`[${rtcLabel}] connectPeer(answer) failed: ${String(err)}`);
            });
            return;
        }

        if (mqttTopic === byeTopic) {
            const byeId = data.id;
            if (!byeId || byeId === agentId) return;
            _removePeer(byeId);
            return;
        }

        if (mqttTopic === willTopic) {
            const willId = data.id;
            if (!willId || willId === agentId) return;
            _markPeerLost(willId);
            return;
        }
    }

    client.on('message', on_mqtt_client_message);

    // ── cleanup ──────────────────────────────────────────────────────────

    if (opts.abortSignal) {
        opts.abortSignal.addEventListener('abort', () => cleanup());
    }

    function cleanup() {
        if (stopped) return;
        stopped = true;
        clearInterval(_sweepInterval);
        client.publish(byeTopic, JSON.stringify({ id: agentId }), { qos: 0, retain: false });
        for (const [k, peer] of _peers) {
            if (peer.groupId === groupId) {
                peer.close();
                _peers.delete(k);
            }
        }
        client.removeListener('connect', on_mqtt_client_connect);
        client.removeListener('message', on_mqtt_client_message);
    }

    // ── return handle ────────────────────────────────────────────────────

    return {
        cleanup,
        setOnInboundStream: cb => {
            _onInboundStream = cb;
        },
        setOnRawMessage: cb => {
            _onRawMessage = cb;
        },
        getPeerIds: () => [..._peers.values()].filter(p => p.groupId === groupId).map(p => p.peerId),
        broadcastProfile: () => {
            const profile = buildAgentProfile();
            for (const peer of _peers.values()) {
                if (peer.groupId !== groupId) continue;
                peer.agent.profile = profile;
                peer.send(JSON.stringify({ type: 'profile', profile }));
            }
        }
    };
}
