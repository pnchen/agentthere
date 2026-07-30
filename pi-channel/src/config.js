/**
 * Single-file configuration for the standalone agentthere service.
 *
 * `loadConfig()` resolves and stores the home directory in module state.
 * Subsequent calls to workspace/identity helpers read it automatically.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";

let _homeDir = null;
let _config = null;
let _configWatcher = null;
const _configListeners = new Set();

const DEFAULT_ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
];

function normalizeConfig(raw) {
    const config = { ...raw };
    if (config.allow_from && !config.allowFrom) {
        config.allowFrom = config.allow_from;
        delete config.allow_from;
    }
    if (config.dm_policy && !config.dmPolicy) {
        config.dmPolicy = config.dm_policy;
        delete config.dm_policy;
    }

    // Keep the old single-agent shape readable during migration. The service
    // itself uses only config.agents after normalization.
    if (!config.agents && config.model) {
        const agentName = config.agent?.id || "default";
        const { model, workspace, workspaceDir, name, avatar, stt, tts, skills } = config;
        config.agents = {
            [agentName]: {
                model,
                workspace: workspace ?? workspaceDir,
                name,
                avatar,
                stt,
                tts,
                skills,
            },
        };
        config.groups = Object.fromEntries(
            Object.entries(config.groups || {}).map(([groupId, groupConfig]) => [
                groupId,
                { ...groupConfig, agent: groupConfig.agent || agentName },
            ]),
        );
    }
    return config;
}

export function validateConfig(config) {
    if (!config || typeof config !== "object") {
        throw new Error("agentthere.json must contain an object");
    }
    if (!config.mqtt?.url) {
        throw new Error("agentthere.json mqtt.url is required");
    }
    if (!config.agents || typeof config.agents !== "object" || Array.isArray(config.agents)) {
        throw new Error("agentthere.json agents must be an object");
    }
    if (!config.groups || typeof config.groups !== "object" || Array.isArray(config.groups)) {
        throw new Error("agentthere.json groups must be an object");
    }

    for (const [agentName, agent] of Object.entries(config.agents)) {
        if (!/^[A-Za-z0-9_.-]+$/.test(agentName)) {
            throw new Error(`agent name ${agentName} contains unsupported characters`);
        }
        if (!agent || typeof agent !== "object") {
            throw new Error(`agent ${agentName} must be an object`);
        }
        if (typeof agent.model !== "string" || !agent.model.includes("/")) {
            throw new Error(`agent ${agentName} model must use "provider/model-id" format`);
        }
        if (agent.workspace != null && typeof agent.workspace !== "string") {
            throw new Error(`agent ${agentName} workspace must be a string`);
        }
    }
    for (const [groupId, group] of Object.entries(config.groups)) {
        if (!groupId.trim()) throw new Error("group id must not be empty");
        if (!group || typeof group !== "object" || typeof group.agent !== "string") {
            throw new Error(`group ${groupId} must specify an agent`);
        }
        if (!config.agents[group.agent]) {
            throw new Error(`group ${groupId} references unknown agent ${group.agent}`);
        }
    }
    return config;
}

function resolveConfigHomeDir() {
    const argvHome = process.argv[2];
    return argvHome
        ? path.resolve(argvHome)
        : path.resolve(process.env.AGENTTHERE_HOME || path.join(os.homedir(), ".agentthere"));
}

export function getConfigHomeDir() {
    if (!_homeDir) throw new Error("config home directory is not initialized");
    return _homeDir;
}

export function getConfig() {
    return _config || loadConfig();
}

function readConfig() {
    const configPath = path.join(_homeDir, "agentthere.json");
    try {
        const raw = fs.readFileSync(configPath, "utf-8");
        const config = normalizeConfig(JSON5.parse(raw));
        validateConfig(config);
        return { enabled: true, ...config };
    }
    catch (err) {
        if (err?.code === "ENOENT") return { enabled: false };
        throw new Error(`failed to load ${configPath}: ${String(err)}`);
    }
}

function replaceConfig(nextConfig) {
    if (!_config) {
        _config = nextConfig;
        return;
    }
    for (const key of Object.keys(_config)) delete _config[key];
    Object.assign(_config, nextConfig);
}

async function reloadConfig() {
    try {
        replaceConfig(readConfig());
        for (const listener of _configListeners) await listener(_config);
        console.log("[pi-channel:config] synchronized agentthere.json");
    }
    catch (err) {
        console.error(`[pi-channel:config] reload failed; keeping current config: ${String(err)}`);
    }
}

function watchConfig() {
    if (_configWatcher) return;
    _configWatcher = fs.watch(_homeDir, (_event, filename) => {
        if (!filename || filename.toString() === "agentthere.json") void reloadConfig();
    });
}

export function onConfigChange(listener) {
    _configListeners.add(listener);
    return () => _configListeners.delete(listener);
}

export function loadConfig() {
    _homeDir ||= resolveConfigHomeDir();
    fs.mkdirSync(_homeDir, { recursive: true });
    replaceConfig(readConfig());
    watchConfig();
    return _config;
}

export function resolveIceServers(config) {
    return config.ice_servers ?? config.iceServers ?? DEFAULT_ICE_SERVERS;
}

export function resolveConfiguredGroupIds(config) {
    return Object.keys(config.groups || {});
}

export function resolveAgentId(config) {
    return config.agent?.id || Object.keys(config.agents || {})[0] || "default";
}

export function resolveWorkspaceDir(config) {
    return resolveAgentWorkspaceDir(config, resolveAgentId(config));
}

export function resolveAgentWorkspaceDir(config, agentName) {
    const agent = config.agents?.[agentName] || {};
    const workspace = agent.workspace;
    if (workspace) {
        return path.isAbsolute(workspace) ? workspace : path.resolve(_homeDir, workspace);
    }
    return path.join(_homeDir, "workspaces", agentName);
}

export function resolveAgentIdentity(agentName) {
    const config = getConfig();
    const workspaceDir = resolveAgentWorkspaceDir(config, agentName);
    const identity = loadWorkspaceIdentity(workspaceDir) || {};
    return {
        name: identity.name || agentName,
        ...(identity.creature ? { creature: identity.creature } : {}),
        ...(identity.vibe ? { vibe: identity.vibe } : {}),
        ...(identity.emoji ? { emoji: identity.emoji } : {}),
        ...(identity.avatar ? { avatar: identity.avatar } : {}),
    };
}

export function resolveAgentModel(config, agentName, modelRuntime) {
    const modelSpec = config.agents?.[agentName]?.model;
    const slash = modelSpec?.indexOf("/") ?? -1;
    if (slash <= 0 || slash === modelSpec.length - 1) {
        throw new Error(`configured model not found for agent ${agentName}: ${modelSpec}`);
    }
    const provider = modelSpec.slice(0, slash);
    const modelId = modelSpec.slice(slash + 1);
    const model = modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`configured model not found for agent ${agentName}: ${modelSpec}`);
    return model;
}

// IDENTITY.md is the source of the public Agent identity. The Agent key
// remains the stable configuration alias and is used as the name fallback.
const IDENTITY_PLACEHOLDER_VALUES = new Set([
    "pick something you like",
    "ai? robot? familiar? ghost in the machine? something weirder?",
    "how do you come across? sharp? warm? chaotic? calm?",
    "your signature - pick one that feels right",
    "workspace-relative path, http(s) url, or data uri",
]);

function parseIdentityMarkdown(content) {
    const identity = {};
    for (const line of content.split(/\r?\n/)) {
        const cleaned = line.trim().replace(/^\s*-\s*/, "");
        const colonIdx = cleaned.indexOf(":");
        if (colonIdx === -1) continue;
        const label = cleaned.slice(0, colonIdx).replace(/[*_]/g, "").trim().toLowerCase().replace(/\s+/g, "_");
        const value = cleaned.slice(colonIdx + 1).replace(/^[*_]+|[*_]+$/g, "").trim();
        if (!value || IDENTITY_PLACEHOLDER_VALUES.has(value.toLowerCase())) continue;
        if (label === "name") identity.name = value;
        if (label === "creature") identity.creature = value;
        if (label === "vibe") identity.vibe = value;
        if (label === "emoji") identity.emoji = value;
        if (label === "avatar") identity.avatar = value;
    }
    return identity;
}

export function loadWorkspaceIdentity(workspaceDir) {
    try {
        return parseIdentityMarkdown(fs.readFileSync(path.join(workspaceDir, "IDENTITY.md"), "utf-8"));
    }
    catch {
        return null;
    }
}
