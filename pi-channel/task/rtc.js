/**
 * AgentThere RTC task.
 *
 * Importing this module starts the MQTT/WebRTC task. It owns the process
 * MQTT connection and all Group monitors.
 */
import { randomUUID } from "node:crypto";
import { getConfig, onConfigChange, resolveAgentIdentity, resolveIceServers } from "../src/config.js";
import { getGroup, getGroupPeers, getGroups, getPeer, registerGroup, startGroupMonitor, unregisterGroup } from "../src/rtc/index.js";
import { handleInboundStream, handleRawMessage } from "../src/rtc/inbound.js";
import { MediaTaskManager } from "../src/media/media-task.js";

const { connect } = await import("mqtt");
const clientId = `pi-channel-${randomUUID().slice(0, 6)}`;
const mqttClient = connect(getConfig().mqtt.url, {
    clientId,
    username: getConfig().mqtt.username,
    password: getConfig().mqtt.password,
    reconnectPeriod: 3000,
    keepalive: 120,
});
mqttClient.on("error", (err) => console.error(`[pi-channel:rtc] MQTT error: ${String(err)}`));
mqttClient.on("offline", () => console.warn("[pi-channel:rtc] MQTT offline"));
mqttClient.on("reconnect", () => console.warn("[pi-channel:rtc] MQTT reconnecting..."));
await new Promise((resolve, reject) => {
    if (mqttClient.connected) return resolve();
    mqttClient.once("connect", resolve);
    mqttClient.once("error", reject);
});

const agentPeerId = `agent-${randomUUID()}`;
const namespace = getConfig().mqtt.namespace || "";
const iceServers = resolveIceServers(getConfig());
const abortController = new AbortController();

async function startGroup(groupId) {
    if (getGroup(groupId)) return getGroup(groupId);
    const monitor = await startGroupMonitor({
        client: mqttClient,
        groupId,
        agentPeerId,
        namespace,
        iceServers,
        profile: {
            ...resolveAgentIdentity(getConfig().groups[groupId].agent),
            agent: true,
        },
        abortSignal: abortController.signal,
    });
    const group = {
        groupId,
        agentName: getConfig().groups[groupId].agent,
        monitor,
        mediaTaskManager: new MediaTaskManager(),
        getPeerCount: () => getGroupPeers(groupId).length,
        send: (message) => {
            let sent = 0;
            for (const peer of getGroupPeers(groupId)) if (peer.send(message)) sent++;
            return sent;
        },
        sendMany: (messages) => messages.reduce((sent, message) => sent + group.send(message), 0),
        broadcastProfile: () => monitor.broadcastProfile(),
        getPeers: () => monitor.getPeers(),
    };
    registerGroup(group);
    monitor.setOnRawMessage((raw, peer) => handleRawMessage(groupId, raw, peer));
    monitor.setOnInboundStream((streamHandle, peer) => handleInboundStream(groupId, streamHandle, peer));
    return group;
}

async function stopGroup(groupId) {
    const group = getGroup(groupId);
    if (!group) return null;
    group.mediaTaskManager.stopAll();
    group.monitor.cleanup();
    unregisterGroup(groupId);
    return group;
}

const rtcTask = {
    startGroup,
    stopGroup,
    getGroup,
    getGroups,
    getGroupIds: () => getGroups().map((group) => group.groupId),
    getPeer,
    async syncGroups() {
        for (const [groupId, groupConfig] of Object.entries(getConfig().groups)) {
            const current = getGroup(groupId);
            if (!current) {
                await startGroup(groupId);
                continue;
            }
            if (current.agentName !== groupConfig.agent) {
                await stopGroup(groupId);
                await startGroup(groupId);
            }
        }
        for (const groupId of getGroups().map((group) => group.groupId)) {
            if (getConfig().groups[groupId]) continue;
            await stopGroup(groupId);
        }
    },
    async stop() {
        abortController.abort();
        for (const groupId of getGroups().map((group) => group.groupId)) await stopGroup(groupId);
        mqttClient.end();
    },
};

await rtcTask.syncGroups();
onConfigChange(() => rtcTask.syncGroups());
