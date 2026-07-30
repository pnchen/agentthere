import { createAgentSession as createPiAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager as PiSessionManager } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { ReplyRenderer } from "./reply-renderer.js";
import { GroupOutputStream } from "./group-output.js";
import { createSendChannelFileTool } from "./tools/send-channel-file.js";
import { createAgentBashTool } from "./tools/skill-env.js";
import { getConfig, getConfigHomeDir, resolveAgentIdentity, resolveAgentModel, resolveAgentWorkspaceDir } from "./config.js";
import { getGroup } from "./rtc/index.js";

// ── identity formatting ─────────────────────────────────────────────────

function formatAgentIdentity(identity = {}, { update = false } = {}) {
    const lines = [
        update ? "Agent identity update:" : "You are an AgentThere assistant.",
        update ? "Your current AgentThere identity is:" : "Your AgentThere identity is:",
        identity.name && `- Name: ${identity.name}`,
        identity.creature && `- Creature: ${identity.creature}`,
        identity.vibe && `- Vibe: ${identity.vibe}`,
        identity.emoji && `- Emoji: ${identity.emoji}`,
        identity.name && `When referring to yourself in AgentThere conversations, use the name "${identity.name}".`,
    ];
    return lines.filter(Boolean).join("\n");
}

// ── Agent / Session ─────────────────────────────────────────────────────

/**
 * Create the plain Agent object. It owns configuration and lazily-created
 * per-Group Sessions, but knows nothing about Group Monitor communication.
 */
export function createAgent({ agentName, config, cwd, identity = {} }) {
    return {
        key: agentName,
        config: config.agents[agentName],
        cwd,
        identity,
        sessions: Object.create(null),
        sessionOperations: Object.create(null),
        pendingSessionChanges: Object.create(null),
        identityWatcher: null,
        updateIdentity(nextIdentity) {
            this.identity = { ...nextIdentity };
        },
    };
}

/** Create one Session for an Agent + Group on first use. */
export async function createAgentSession({ agent, group, agentDir, modelRuntime }) {
    const groupId = group.groupId;
    const agentName = agent.key;
    const agentConfig = agent.config;
    const workspaceDir = resolveAgentWorkspaceDir({ agents: { [agentName]: agentConfig } }, agentName);
    const identity = agent.identity || {};
    const identityPrompt = formatAgentIdentity(identity);
    const resourceLoader = new DefaultResourceLoader({
        cwd: workspaceDir,
        agentDir,
        appendSystemPrompt: [identityPrompt],
    });
    await resourceLoader.reload();

    const profile = { ...identity, agent: true };
    const getGroupIds = () => [groupId];
    const sendChannelFileTool = createSendChannelFileTool({
        getAgentProfile: () => profile,
        getGroupIds,
    });
    const bash = createAgentBashTool({
        workspaceDir,
        skills: resourceLoader.getSkills().skills,
        getAgentConfig: () => agent.config,
        agentName,
        groupId,
    });
    const { session } = await createPiAgentSession({
        cwd: workspaceDir,
        agentDir,
        modelRuntime,
        resourceLoader,
        model: resolveAgentModel({ agents: { [agentName]: agent.config } }, agentName, modelRuntime),
        ...(agentConfig.thinking_level !== undefined ? { thinkingLevel: agentConfig.thinking_level } : {}),
        tools: ["read", "edit", "write", "bash", "send_channel_file"],
        customTools: [bash, sendChannelFileTool],
        sessionManager: sessionManager.get(agentName, groupId),
    });

    // ── reply renderer ─────────────────────────────────────────────────
    const output = new GroupOutputStream({
        groupId,
        agentFrom: () => profile,
        ttsConfig: () => agent.config.tts,
    });
    const replyRenderer = new ReplyRenderer({
        agentFrom: () => profile,
        output,
        getThinkLevel: () => session.thinkingLevel,
        getContextUsage: () => session.getContextUsage?.(),
    });

    // ── identity update ────────────────────────────────────────────────
    let pendingIdentityUpdate = null;
    let identityUpdateRunning = false;
    async function dispatchIdentityUpdate() {
        if (identityUpdateRunning) return;
        identityUpdateRunning = true;
        try {
            while (pendingIdentityUpdate) {
                const ident = pendingIdentityUpdate;
                pendingIdentityUpdate = null;
                const message = {
                    customType: "agent_identity_update",
                    content: [{ type: "text", text: formatAgentIdentity(ident, { update: true }) }],
                    display: false,
                    details: { identity: ident },
                };
                try {
                    if (session.isStreaming) {
                        await session.sendCustomMessage(message, { deliverAs: "steer" });
                    }
                    else {
                        await session.sendCustomMessage(message, { triggerTurn: true });
                    }
                }
                catch (error) {
                    pendingIdentityUpdate = ident;
                    console.warn(`[pi-channel:identity] update failed: ${String(error)}`);
                    break;
                }
            }
        }
        finally {
            identityUpdateRunning = false;
        }
    }

    function updateIdentity(identity) {
        for (const key of ["name", "creature", "vibe", "emoji", "avatar"]) {
            if (identity?.[key]) profile[key] = identity[key];
            else delete profile[key];
        }
        profile.agent = true;
        pendingIdentityUpdate = { ...identity };
        void dispatchIdentityUpdate();
    }

    // ── start / stop ───────────────────────────────────────────────────
    let _unsubSession;
    function start() {
        _unsubSession = session.subscribe((event) => replyRenderer.handle(event));
        console.log("[pi-channel:agent] session started");
    }

    function stop() {
        _unsubSession?.();
        replyRenderer.clearRound();
        output.close();
        session.dispose();
        console.log("[pi-channel:agent] session stopped");
    }

    return {
        groupId,
        session,
        replyRenderer,
        output,
        resourceLoader,
        agentKey: agentName,
        getAgentProfile: () => profile,
        getSttConfig: () => agent.config.stt,
        getTtsConfig: () => agent.config.tts,
        updateIdentity,
        start,
        stop,
    };
}

const agents = Object.create(null);
const sessionManager = {
    values: new Map(),
    key(agentName, groupId) {
        return `${agentName}-${groupId}`;
    },
    get(agentName, groupId) {
        return this.values.get(this.key(agentName, groupId));
    },
    set(agentName, groupId, manager) {
        this.values.set(this.key(agentName, groupId), manager);
        return manager;
    },
    delete(agentName, groupId) {
        this.values.delete(this.key(agentName, groupId));
    },
};
let modelRuntimePromise;

function findAgent(agentName) {
    return Object.values(agents).find((agent) => agent.key === agentName) || null;
}

function getGroupIdsForAgent(agentName) {
    return Object.entries(getConfig().groups || {})
        .filter(([, group]) => group.agent === agentName)
        .map(([groupId]) => groupId);
}

function createAgentRecord(agentName) {
    const agent = createAgent({
        agentName,
        config: getConfig(),
        cwd: getConfigHomeDir(),
        identity: resolveAgentIdentity(agentName),
    });
    const identityFile = path.join(resolveAgentWorkspaceDir(getConfig(), agentName), "IDENTITY.md");
    try {
        agent.identityWatcher = fs.watch(identityFile, () => {
            const identity = resolveAgentIdentity(agentName);
            agent.updateIdentity(identity);
            for (const groupId of getGroupIdsForAgent(agentName)) {
                const session = agent.sessions[groupId];
                if (session?.then) session.then((created) => created.updateIdentity(identity)).catch(() => {});
                else session?.updateIdentity(identity);
                getGroup(groupId)?.monitor.broadcastProfile();
            }
        });
        agent.identityWatcher.on("error", () => agent.identityWatcher?.close());
    }
    catch {
        // Missing IDENTITY.md is valid; the Agent key is the name fallback.
    }
    return agent;
}

export function getOrCreateAgent(agentName) {
    let agent = findAgent(agentName);
    if (!agent) {
        agent = createAgentRecord(agentName);
        agents[agentName] = agent;
    }
    agent.config = getConfig().agents[agentName];
    return agent;
}

function getModelRuntime() {
    modelRuntimePromise ||= ModelRuntime.create();
    return modelRuntimePromise;
}

function resolveSessionRef(sessionRef) {
    return sessionRef?.then ? sessionRef : Promise.resolve(sessionRef);
}

function enqueueSessionOperation(agent, groupId, operation) {
    const previous = agent.sessionOperations[groupId] || Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    agent.sessionOperations[groupId] = next;
    void next.finally(() => {
        if (agent.sessionOperations[groupId] === next) delete agent.sessionOperations[groupId];
    }).catch(() => {});
    return next;
}

function sessionMetadata(agentName, groupId) {
    return {
        schema_version: 1,
        agent_name: agentName,
        group_id: groupId,
    };
}

function createNewSessionManager(workspaceDir, agentName, groupId) {
    const manager = PiSessionManager.create(workspaceDir);
    manager.appendCustomEntry("agentthere.session", sessionMetadata(agentName, groupId));
    return sessionManager.set(agentName, groupId, manager);
}

function readSessionMetadata(sessionFile) {
    try {
        const lines = fs.readFileSync(sessionFile, "utf8").split("\n");
        let metadata = null;
        for (const line of lines) {
            if (!line.trim()) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            if (entry.type === "custom" && entry.customType === "agentthere.session") {
                metadata = entry.data;
            }
        }
        return metadata;
    }
    catch {
        return null;
    }
}

function getSessionWorkspace(agent) {
    return resolveAgentWorkspaceDir({ agents: { [agent.key]: agent.config } }, agent.key);
}

async function listPersistedSessions(agent, groupId) {
    const sessions = await PiSessionManager.list(getSessionWorkspace(agent));
    return sessions
        .map((session) => ({ ...session, metadata: readSessionMetadata(session.path) }))
        .filter((session) => session.metadata?.agent_name === agent.key && session.metadata?.group_id === groupId)
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

async function findLatestSessionManager(agent, groupId) {
    const latest = (await listPersistedSessions(agent, groupId))[0];
    return latest
        ? sessionManager.set(agent.key, groupId, PiSessionManager.open(latest.path))
        : createNewSessionManager(getSessionWorkspace(agent), agent.key, groupId);
}

async function applyPendingSessionChange(agent, group, current) {
    const groupId = group.groupId;
    const pending = agent.pendingSessionChanges[groupId];
    if (!pending) return current;

    const previousManager = sessionManager.get(agent.key, groupId);
    let nextManager;
    if (pending.type === "new") {
        nextManager = PiSessionManager.create(getSessionWorkspace(agent));
        nextManager.appendCustomEntry("agentthere.session", sessionMetadata(agent.key, groupId));
    }
    else {
        nextManager = PiSessionManager.open(pending.path);
    }
    sessionManager.set(agent.key, groupId, nextManager);

    try {
        const created = await createLoadedAgentSession(agent, group);
        agent.sessions[groupId] = created;
        delete agent.pendingSessionChanges[groupId];
        current?.stop();
        return created;
    }
    catch (error) {
        if (previousManager) sessionManager.set(agent.key, groupId, previousManager);
        throw error;
    }
}

async function createLoadedAgentSession(agent, group) {
    const created = await createAgentSession({
        agent,
        group,
        agentDir: getAgentDir(),
        modelRuntime: await getModelRuntime(),
    });
    created.start();
    return created;
}

export async function getAgentSessionForGroup(groupId) {
    const group = getGroup(groupId);
    if (!group) return null;
    const agent = findAgent(group.agentName);
    if (!agent) return null;

    const operation = agent.sessionOperations[groupId];
    if (operation) return operation;
    const pending = agent.pendingSessionChanges[groupId];
    const existing = agent.sessions[groupId];
    if (existing && !pending) return existing;

    const session = enqueueSessionOperation(agent, groupId, async () => {
        const current = await resolveSessionRef(existing);
        if (agent.pendingSessionChanges[groupId]) return applyPendingSessionChange(agent, group, current);
        if (current) return current;
        await findLatestSessionManager(agent, groupId);
        const created = await createLoadedAgentSession(agent, group);
        agent.sessions[groupId] = created;
        return created;
    });
    agent.sessions[groupId] = session;
    void session.catch(() => {
        if (agent.sessions[groupId] === session) delete agent.sessions[groupId];
    });
    return session;
}

export async function getCurrentAgentSessionForGroup(groupId) {
    const group = getGroup(groupId);
    const agent = group && findAgent(group.agentName);
    const session = agent && await resolveSessionRef(agent.sessions[groupId]);
    return session?.session?.sessionFile || null;
}

export async function requestSwitchAgentSessionForGroup(groupId, sessionId) {
    const group = getGroup(groupId);
    if (!group) throw new Error(`Group not found: ${groupId}`);
    const agent = findAgent(group.agentName);
    if (!agent) throw new Error(`Agent not found: ${group.agentName}`);
    const selected = (await listPersistedSessions(agent, groupId)).find((session) => session.id === sessionId);
    if (!selected) throw new Error(`Session not found: ${sessionId}`);
    agent.pendingSessionChanges[groupId] = { type: "switch", sessionId, path: selected.path };
}

export function requestNewAgentSessionForGroup(groupId) {
    const group = getGroup(groupId);
    if (!group) throw new Error(`Group not found: ${groupId}`);
    const agent = findAgent(group.agentName);
    if (!agent) throw new Error(`Agent not found: ${group.agentName}`);
    agent.pendingSessionChanges[groupId] = { type: "new" };
}

export function getAgentRecords() {
    return Object.values(agents);
}

export async function syncAgentSessions() {
    const modelRuntime = await getModelRuntime();

    for (const agent of getAgentRecords()) {
        if (!getConfig().agents?.[agent.key]) continue;

        let model;
        try {
            model = resolveAgentModel(
                { agents: { [agent.key]: agent.config } },
                agent.key,
                modelRuntime,
            );
        }
        catch (error) {
            console.warn(`[pi-channel:agent] model reload failed agent=${agent.key}: ${String(error)}`);
            continue;
        }

        for (const [groupId, sessionRef] of Object.entries(agent.sessions)) {
            const session = sessionRef?.then ? await sessionRef.catch(() => null) : sessionRef;
            if (!session?.session) continue;

            const current = session.session.model;
            if (current?.provider === model.provider && current?.id === model.id) continue;

            try {
                await session.session.waitForIdle?.();
                await session.session.setModel(model);
                console.log(`[pi-channel:agent] model updated agent=${agent.key} group=${groupId} model=${model.provider}/${model.id}`);
            }
            catch (error) {
                console.warn(`[pi-channel:agent] model update failed agent=${agent.key} group=${groupId}: ${String(error)}`);
            }
        }
    }
}

export function removeAgent(agentName) {
    const agent = agents[agentName];
    if (!agent) return;
    agent.identityWatcher?.close();
    delete agents[agentName];
}
