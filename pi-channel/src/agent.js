import { createAgentSession as createPiAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { SdkBridge } from "./sdk-bridge.js";
import { MediaTaskManager } from "./media/media-task.js";
import { createMediaTaskTools } from "./tools/media-task-tools.js";
import { createSendChannelFileTool } from "./tools/send-channel-file.js";
import { createAgentBashTool } from "./skill-env.js";
import { resolveAgentModel, resolveAgentWorkspaceDir } from "./config.js";

/**
 * Create the plain Agent object. It owns configuration and lazily-created
 * per-Group Sessions, but knows nothing about Group Monitor communication.
 */
export function createAgent({ agentName, config, cwd }) {
    return {
        key: agentName,
        config: config.agents[agentName],
        cwd,
        sessions: Object.create(null),
        identityRef: { current: null },
        identityWatcher: null,
    };
}

/** Create one Session for an Agent + Group on first use. */
export async function createAgentSession({ agent, groupId, getGroup, getGroupConfig, agentDir, modelRuntime, identityRef }) {
    const agentName = agent.key;
    const agentConfig = agent.config;
    const workspaceDir = resolveAgentWorkspaceDir({ agents: { [agentName]: agentConfig } }, agentName);
    const resourceLoader = new DefaultResourceLoader({ cwd: workspaceDir, agentDir });
    await resourceLoader.reload();

    const profile = { ...identityRef.current, agent: true };
    const mediaTaskManager = new MediaTaskManager();
    const peerContext = { current: null };
    const getGroupIds = () => [groupId];
    const sendChannelFileTool = createSendChannelFileTool({
        getAgentProfile: () => profile,
        getGroupIds,
    });
    const mediaTaskTools = createMediaTaskTools(mediaTaskManager, {
        getGroupIds,
        getPeerContext: () => peerContext.current,
    });
    const bash = createAgentBashTool({
        workspaceDir,
        skills: resourceLoader.getSkills().skills,
        getAgentConfig: () => agent.config,
        agentName,
    });
    const { session } = await createPiAgentSession({
        cwd: workspaceDir,
        agentDir,
        modelRuntime,
        resourceLoader,
        model: resolveAgentModel({ agents: { [agentName]: agent.config } }, agentName, modelRuntime),
        ...(agentConfig.thinking_level !== undefined ? { thinkingLevel: agentConfig.thinking_level } : {}),
        tools: ["read", "edit", "write", "bash", "send_channel_file", "play_media", "stop_media", "media_status"],
        customTools: [bash, sendChannelFileTool, ...mediaTaskTools],
        sessionManager: SessionManager.create(workspaceDir, undefined, { id: `${agentName}-${groupId.replace(/[^A-Za-z0-9_.-]+/g, "-")}` }),
    });

    const syncConfig = async () => {
        const nextModel = resolveAgentModel({ agents: { [agentName]: agent.config } }, agentName, modelRuntime);
        if (session.model?.provider !== nextModel.provider || session.model?.id !== nextModel.id) {
            await session.setModel(nextModel);
        }
        if (agent.config.thinking_level !== undefined && session.thinkingLevel !== agent.config.thinking_level) {
            session.setThinkingLevel(agent.config.thinking_level);
        }
    };
    const bridge = new SdkBridge({
        session,
        getGroup,
        groupId,
        agentProfile: profile,
        workspaceDir,
        getSttConfig: () => agent.config.stt,
        getTtsConfig: () => agent.config.tts,
        agentKey: agentName,
        agentConfigSync: syncConfig,
        peerContext,
        resourceLoader,
        getGroupConfig,
    });
    return {
        groupId,
        session,
        bridge,
        resourceLoader,
        mediaTaskManager,
        start() { bridge.start({ wireMonitors: false }); },
        updateIdentity(identity) { bridge.updateIdentity({ ...identity, agent: true }); },
        stop() {
            bridge.stop();
            mediaTaskManager.stopAll();
            session.dispose();
        },
    };
}
