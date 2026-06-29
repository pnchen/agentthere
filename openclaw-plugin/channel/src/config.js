/**
 * AgentThere plugin configuration helpers.
 *
 * Resolves plugin-specific settings from the OpenClawConfig object at
 * `cfg.channels.agentthere.*`.  Provides typed defaults so callers never
 * have to deal with undefined.
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from 'openclaw/plugin-sdk/agent-runtime';

// ── identity (name/avatar/wake words) ─────────────────────────────────────────
//
// Workspace path comes straight from core (`resolveAgentWorkspaceDir`) so the
// directory the agent writes IDENTITY.md into is the same one AgentThere reads from.
// AgentThere only consumes a small identity subset (name, avatar, wake_words).

const IDENTITY_PLACEHOLDER_VALUES = new Set([
    'pick something you like',
    'ai? robot? familiar? ghost in the machine? something weirder?',
    'how do you come across? sharp? warm? chaotic? calm?',
    'your signature - pick one that feels right',
    'workspace-relative path, http(s) url, or data uri'
]);

function parseIdentityMarkdown(content) {
    const identity = {};
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
        const cleaned = line.trim().replace(/^\s*-\s*/, '');
        const colonIdx = cleaned.indexOf(':');
        if (colonIdx === -1) continue;
        const label = cleaned.slice(0, colonIdx).replace(/[*_]/g, '').trim().toLowerCase().replace(/\s+/g, '_');
        const value = cleaned
            .slice(colonIdx + 1)
            .replace(/^[*_]+|[*_]+$/g, '')
            .trim();
        if (!value) continue;
        const normalized = value
            .replace(/^[*_]+|[*_]+$/g, '')
            .trim()
            .replace(/^\(|\)$/g, '')
            .trim()
            .replace(/[\u2013\u2014]/g, '-')
            .replace(/\s+/g, ' ')
            .toLowerCase();
        if (IDENTITY_PLACEHOLDER_VALUES.has(normalized)) continue;
        if (label === 'name') identity.name = value;
        if (label === 'avatar') identity.avatar = value;
        if (label === 'wake_words') identity.wake_words = value;
    }
    return identity;
}

function loadWorkspaceIdentity(workspaceDir) {
    if (!workspaceDir) return null;
    try {
        const content = fs.readFileSync(path.join(workspaceDir, 'IDENTITY.md'), 'utf-8');
        const result = parseIdentityMarkdown(content);
        if (result.name || result.avatar || result.wake_words) return result;
    } catch {
        /* file missing or unreadable */
    }
    return null;
}

// ── config readers ────────────────────────────────────────────────────────────

function getChannelConfig(cfg) {
    const ch = cfg.channels;
    return ch?.['agentthere'] ?? {};
}

function getGroupConfig(cfg, groupName) {
    if (!groupName) return undefined;
    const ch = getChannelConfig(cfg);
    const groups = ch.groups;
    if (!groups || typeof groups !== 'object') return undefined;
    return groups[groupName];
}

function resolveAgentEntry(cfg, agentId) {
    if (!agentId) return undefined;
    const target = String(agentId).trim().toLowerCase();
    return (cfg.agents?.list ?? []).find(e => (e?.id ?? '').toString().trim().toLowerCase() === target);
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Resolve effective AgentThere agent profile for a group.
 *
 * - `agentId` comes from `channels.agentthere.groups.<group>.openclaw_agent_id`,
 *   falling back to core's `resolveDefaultAgentId(cfg)`.
 * - `name`/`avatar`/`wake_words` are sourced from (in order):
 *     1) `agents.list[<id>].identity.{name,avatar,wake_words}` (config-level)
 *     2) `<workspace>/IDENTITY.md` matching fields
 * - Workspace path uses core's `resolveAgentWorkspaceDir` —
 *
 * Returns `{ identity: { name, avatar, wake_words }, agentId }`.
 */
export function resolveAgentIdentityForGroup(cfg, groupName) {
    const openclawAgentId = resolveGroupOpenClawAgentId(cfg, groupName) ?? resolveDefaultAgentId(cfg);

    const configIdentity = resolveAgentEntry(cfg, openclawAgentId)?.identity;

    let wsIdentity = null;
    try {
        const wsDir = resolveAgentWorkspaceDir(cfg, openclawAgentId);
        wsIdentity = loadWorkspaceIdentity(wsDir);
    } catch {
        // Workspace path not resolvable — config-level identity still works.
    }

    const identity = { ...configIdentity, ...wsIdentity };

    return { identity, agentId: openclawAgentId };
}

export function listAccountIds(cfg) {
    const ch = getChannelConfig(cfg);
    if (ch.enabled === false) return [];
    const accountId = ch.account_id;
    // Default to "default" when not explicitly set
    return accountId ? [accountId] : ['default'];
}

export function resolveAccount(cfg, accountId) {
    if (!accountId) return null;
    const id = String(accountId);
    const ch = getChannelConfig(cfg);
    const groupIds = Object.keys(ch.groups ?? {});

    const openclawAgentId = resolveDefaultAgentId(cfg);
    const configIdentity = resolveAgentEntry(cfg, openclawAgentId)?.identity;
    let wsIdentity = null;
    try {
        const wsDir = resolveAgentWorkspaceDir(cfg, openclawAgentId);
        wsIdentity = loadWorkspaceIdentity(wsDir);
    } catch {
        /* ignore */
    }

    const defaultIceServers = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];

    return {
        accountId: id,
        enabled: ch.enabled !== false,
        configured: true,
        signalingConfigured: Boolean(ch.mqtt?.url),
        iceServers: ch.ice_servers ?? defaultIceServers,
        dmPolicy: ch.dmPolicy ?? 'pairing',
        allowFrom: ch.allowFrom ?? [],
        mqtt: ch.mqtt ?? null,
        groupIds,
        identity: {
            ...configIdentity,
            ...wsIdentity
        },
        agentId: openclawAgentId,
        groups: ch.groups ?? {}
    };
}

/**
 * Resolve per-group skill filter from channels.agentthere.groups.<groupName>.skills
 */
export function resolveGroupSkillFilter(cfg, groupName) {
    const groupConfig = getGroupConfig(cfg, groupName);
    if (!groupConfig) return undefined;
    const skills = groupConfig.skills;
    if (!Array.isArray(skills)) return undefined;
    return skills.map(String);
}

/**
 * Resolve optional per-group system prompt from channels.agentthere.groups.<group>.systemPrompt.
 */
export function resolveGroupSystemPrompt(cfg, groupName) {
    const groupConfig = getGroupConfig(cfg, groupName);
    return (typeof groupConfig?.systemPrompt === 'string' && groupConfig.systemPrompt) || undefined;
}

/**
 * Resolve optional group-level OpenClaw routing agent override.
 * Config path: channels.agentthere.groups.<group>.openclaw_agent_id
 */
export function resolveGroupOpenClawAgentId(cfg, groupName) {
    const groupConfig = getGroupConfig(cfg, groupName);
    return (typeof groupConfig?.openclaw_agent_id === 'string' && groupConfig.openclaw_agent_id) || undefined;
}

/**
 * Resolve per-group verbose mode.
 *
 * Config path: channels.agentthere.groups.<groupName>.verbose
 *
 * Returns `"on" | "off" | "full"` if configured, `undefined` otherwise.
 * Caller should default to `"on"` (AgentThere always streams tool progress).
 */
export function resolveGroupVerbose(cfg, groupName) {
    const groupConfig = getGroupConfig(cfg, groupName);
    if (!groupConfig) return undefined;
    const val = groupConfig.verbose;
    if (val === 'on' || val === 'off' || val === 'full') return val;
    return undefined;
}
