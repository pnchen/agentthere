/**
 * Pi Channel Service — standalone headless AgentThere channel bot.
 *
 * agentthere.json is the live configuration model. MQTT and ICE are read once
 * at startup; Agent and Group changes are synchronized in memory.
 */
import { ModelRuntime, getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, resolveAgentIdentity, resolveAgentWorkspaceDir, resolveIceServers } from "./src/config.js";
import { getGroupPeers, startGroupMonitor } from "./src/rtc/index.js";
import { OutboundResponse } from "./src/channel/router/res.js";
import { createAgent, createAgentSession } from "./src/agent.js";

// Resolve agentthere home directory. Default: ~/.agentthere/
const argvHome = process.argv[2];
const homeDir = argvHome
    ? path.resolve(argvHome)
    : path.resolve(process.env.AGENTTHERE_HOME || path.join(os.homedir(), ".agentthere"));
fs.mkdirSync(homeDir, { recursive: true });

const agentDir = getAgentDir();
const configPath = path.join(homeDir, "agentthere.json");
const initialConfig = loadConfig(homeDir);
console.log(`[agentthere:service] config dir: ${homeDir}`);

if (!initialConfig.enabled) {
    console.error(`[agentthere:service] config not found: ${configPath}`);
    process.exit(0);
}

// config is the live JSON model. agents/groups contain only runtime objects.
const config = initialConfig;
const agents = Object.create(null);
const groups = Object.create(null);
const { connect } = await import("mqtt");
const clientId = `pi-channel-${randomUUID().slice(0, 6)}`;
const mqttClient = connect(config.mqtt.url, {
    clientId,
    username: config.mqtt.username,
    password: config.mqtt.password,
    reconnectPeriod: 3000,
    keepalive: 120,
});
mqttClient.on("error", (err) => console.error(`[pi-channel:service] MQTT error: ${String(err)}`));
mqttClient.on("offline", () => console.warn("[pi-channel:service] MQTT offline"));
mqttClient.on("reconnect", () => console.warn("[pi-channel:service] MQTT reconnecting..."));
await new Promise((resolve, reject) => {
    if (mqttClient.connected) return resolve();
    mqttClient.once("connect", resolve);
    mqttClient.once("error", reject);
});

const sessionPeerId = `agent-${randomUUID()}`;
const namespace = config.mqtt.namespace || "";
const iceServers = resolveIceServers(config);
const abortController = new AbortController();
const modelRuntime = await ModelRuntime.create();

function replaceConfig(nextConfig) {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, nextConfig);
}

function createAgentRecord(agentName) {
    const agent = createAgent({ agentName, config, cwd: homeDir });
    agent.identityRef.current = resolveAgentIdentity(config, agentName);
    const identityFile = path.join(resolveAgentWorkspaceDir(config, agentName), "IDENTITY.md");
    try {
        agent.identityWatcher = fs.watch(identityFile, () => {
            agent.identityRef.current = resolveAgentIdentity(config, agentName);
            for (const group of Object.values(groups)) {
                if (group.agentName !== agentName) continue;
                const session = findAgent(agentName)?.sessions[group.groupId];
                if (session?.then) {
                    session.then((created) => created.updateIdentity(agent.identityRef.current)).catch(() => {});
                }
                else {
                    session?.updateIdentity(agent.identityRef.current);
                }
                group.broadcastProfile();
            }
        });
        agent.identityWatcher.on("error", () => agent.identityWatcher?.close());
    }
    catch {
        // Missing IDENTITY.md is valid; the Agent key is the name fallback.
    }
    return agent;
}

function findAgent(agentName) {
    return Object.values(agents).find((agent) => agent.key === agentName) || null;
}

function getOrCreateAgent(agentName) {
    let agent = findAgent(agentName);
    if (!agent) {
        agent = createAgentRecord(agentName);
        agents[agentName] = agent;
    }
    agent.config = config.agents[agentName];
    return agent;
}

// Group only creates and owns communication. It does not create an Agent or
// Session. Sessions are created lazily when this Group first receives data.
async function startGroup(groupId) {
    if (groups[groupId]) return;
    const monitor = await startGroupMonitor({
        client: mqttClient,
        groupId,
        sessionPeerId,
        namespace,
        iceServers,
        identity: () => {
            const agentName = config.groups[groupId]?.agent;
            const agent = findAgent(agentName);
            return {
                ...(agent?.identityRef.current || resolveAgentIdentity(config, agentName)),
                agent: true,
            };
        },
        abortSignal: abortController.signal,
    });
    const group = {
        groupId,
        agentName: config.groups[groupId].agent,
        monitor,
        getPeerCount: () => getGroupPeers(groupId).length,
        send: (message) => {
            let sent = 0;
            for (const peer of getGroupPeers(groupId)) if (peer.send(message)) sent++;
            return sent;
        },
        sendMany: (messages) => messages.reduce((sent, message) => sent + group.send(message), 0),
        createResponse: ({ peerId, agentFrom }) => new OutboundResponse({
            mode: "group",
            groupId,
            peerId,
            send: (payload) => group.send(JSON.stringify(payload)),
            agentFrom,
        }),
        broadcastProfile: () => monitor.broadcastProfile(),
    };
    groups[groupId] = group;
    monitor.setOnRawMessage((raw, peer) => handleGroupMessage(groupId, raw, peer));
    monitor.setOnInboundStream((streamHandle, peer) => handleGroupStream(groupId, streamHandle, peer));
}

async function stopGroup(groupId) {
    const group = groups[groupId];
    if (!group) return;
    group.monitor.cleanup();
    const agent = findAgent(group.agentName);
    const session = agent?.sessions[groupId];
    if (session?.then) {
        const created = await session.catch(() => null);
        created?.stop();
    }
    else {
        session?.stop();
    }
    if (agent) delete agent.sessions[groupId];
    delete groups[groupId];
    const stillUsed = Object.values(groups).some((item) => item.agentName === group.agentName);
    if (!stillUsed && agent) {
        agent.identityWatcher?.close();
        delete agents[group.agentName];
    }
}

async function getAgentSessionForGroup(groupId) {
    const group = groups[groupId];
    if (!group) return null;
    const agent = findAgent(group.agentName);
    if (!agent) return null;

    let session = agent.sessions[groupId];
    if (!session) {
        session = createAgentSession({
            agent,
            groupId,
            getGroup: () => groups[groupId],
            getGroupConfig: (gid) => config.groups?.[gid] || {},
            agentDir,
            modelRuntime,
            identityRef: agent.identityRef,
        }).then((created) => {
            created.start();
            agent.sessions[groupId] = created;
            return created;
        });
        agent.sessions[groupId] = session;
    }
    return session;
}

async function handleGroupMessage(groupId, raw, peer) {
    const session = await getAgentSessionForGroup(groupId);
    const created = await session;
    await created?.bridge.handleRawMessage(raw, peer, groupId);
}

async function handleGroupStream(groupId, streamHandle, peer) {
    const session = await getAgentSessionForGroup(groupId);
    const created = await session;
    await created?.bridge.handleInboundStream(groupId, streamHandle, peer);
}

async function syncGroups() {
    for (const [groupId, groupConfig] of Object.entries(config.groups)) {
        const current = groups[groupId];
        if (!current) {
            await startGroup(groupId);
            continue;
        }
        if (current.agentName !== groupConfig.agent) {
            await stopGroup(groupId);
            await startGroup(groupId);
        }
    }
    for (const groupId of Object.keys(groups)) {
        if (!config.groups[groupId]) await stopGroup(groupId);
    }
}

function syncAgents() {
    for (const agentName of Object.keys(config.agents)) {
        getOrCreateAgent(agentName);
    }
    for (const [agentName, agent] of Object.entries(agents)) {
        if (!config.agents[agentName]) {
            agent.identityWatcher?.close();
            delete agents[agentName];
        }
    }
}

async function reloadConfig() {
    try {
        const nextConfig = loadConfig(homeDir);
        replaceConfig(nextConfig);
        syncAgents();
        await syncGroups();
        console.log("[pi-channel:config] synchronized agentthere.json");
    }
    catch (err) {
        console.error(`[pi-channel:config] reload failed; keeping current config: ${String(err)}`);
    }
}

const configWatcher = fs.watch(homeDir, (_event, filename) => {
    if (!filename || filename.toString() === "agentthere.json") reloadConfig();
});

syncAgents();
await syncGroups();
console.log(`[pi-channel:service] started ${Object.keys(groups).length} Group(s), ${Object.keys(agents).length} Agent(s)`);

async function shutdown() {
    console.log("[pi-channel:service] shutting down...");
    configWatcher.close();
    abortController.abort();
    for (const groupId of Object.keys(groups)) await stopGroup(groupId);
    for (const agent of Object.values(agents)) agent.identityWatcher?.close();
    mqttClient.end();
    process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await new Promise(() => {});
