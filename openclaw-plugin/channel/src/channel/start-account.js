/**
 * AgentThere channel account lifecycle — composition root.
 *
 * Assembles the middleware app, wires injected services, starts MQTT
 * group monitors, and bridges raw DataChannel messages into the
 * middleware pipeline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { resolvePreferredOpenClawTmpDir } from 'openclaw/plugin-sdk/sandbox';

import { getRuntime } from '../runtime.js';
import {
    resolveAgentIdentityForGroup,
    resolveGroupSkillFilter,
    resolveGroupSystemPrompt,
    resolveGroupOpenClawAgentId,
    resolveGroupVerbose,
    resolveAccount
} from '../config.js';
import { resolveAgentWorkspaceDir } from 'openclaw/plugin-sdk/agent-runtime';
import { resolveConfiguredGroupIds } from './status.js';
import { messageHandler } from './route/message.js';
import { Router } from './router/index.js';
import { OutboundResponse } from './router/res.js';
import { createContext } from './router/context.js';
import { startGroupMonitor, getGroupPeers } from './rtc/index.js';
import { callHandler } from './route/call/index.js';
import { createMessageId } from './messaging.js';

// ── middleware ──────────────────────────────────────────────────────
import { intentDetection } from './middleware/intent-detection.js';
import { inFlightSteer } from './middleware/inflight.js';
import { authGate } from './middleware/auth-gate.js';
import { historyContext } from './middleware/history-context.js';

// ── shared state ───────────────────────────────────────────────────
export const groupDispatchHandlers = new Map();

// ── inbound file transfer ──────────────────────────────────────────

/** In-progress file transfer tracker. Key = object_id */
const inFlightTransfers = new Map();

/** Auto-cleanup stale transfers after 5 minutes. */
const TRANSFER_TIMEOUT_MS = 5 * 60 * 1000;

function registerIncomingFile(meta) {
    const { object_id } = meta;
    if (inFlightTransfers.has(object_id)) return; // duplicate

    inFlightTransfers.set(object_id, {
        meta,
        chunks: [],
        received: 0,
        startedAt: Date.now()
    });

    console.log(`[agentthere/file] receiving "${meta.file.name}" (${meta.file.size} bytes) object_id=${object_id}`);

    setTimeout(() => {
        if (inFlightTransfers.has(object_id)) {
            console.log(`[agentthere/file] transfer ${object_id} timed out, discarding`);
            inFlightTransfers.delete(object_id);
        }
    }, TRANSFER_TIMEOUT_MS);
}

function handleIncomingChunk(message) {
    const { object_id, chunk } = message;
    const transfer = inFlightTransfers.get(object_id);
    if (!transfer) return null;

    const data = Buffer.from(chunk.data, 'base64');
    transfer.chunks.push({ offset: chunk.offset, data });
    transfer.received += data.length;

    if (transfer.received >= transfer.meta.file.size) {
        transfer.chunks.sort((a, b) => a.offset - b.offset);
        const fullBuffer = Buffer.concat(transfer.chunks.map(c => c.data));
        inFlightTransfers.delete(object_id);
        console.log(`[agentthere/file] completed "${transfer.meta.file.name}" (${fullBuffer.length} bytes)`);
        return {
            buffer: fullBuffer,
            fileName: transfer.meta.file.name,
            mimeType: transfer.meta.file.type || 'application/octet-stream',
            size: fullBuffer.length
        };
    }

    return null;
}

function persistInboundFile(fileName, buffer) {
    const parsed = path.parse(fileName || 'file');
    const safeName = (parsed.name || 'file').replace(/[\/\\:*?"<>|]/g, '_');
    const ext = parsed.ext || '';
    const tmpDir = path.join(resolvePreferredOpenClawTmpDir(), 'agentthere-files');
    fs.mkdirSync(tmpDir, { recursive: true });
    const savedPath = path.join(tmpDir, `${safeName}---${randomUUID()}${ext}`);
    fs.writeFileSync(savedPath, buffer);
    return savedPath;
}

// ── main ───────────────────────────────────────────────────────────

export async function startAccount(ctx) {
    const account = ctx.account;
    const runtime = getRuntime();
    let cfg = ctx.cfg;
    const { abortSignal } = ctx;
    // ── DEV: event-loop lag probe ───────────────────────────────
    if (!globalThis.__LoopLagProbeInstalled) {
        globalThis.__LoopLagProbeInstalled = true;
        let last = Date.now();
        setInterval(() => {
            const now = Date.now();
            const lag = now - last - 500;
            last = now;
            if (lag > 1000) console.error(`[agentthere:loop-lag] blocked ${lag}ms ending @ ${new Date(now).toISOString()}`);
        }, 500).unref();
    }

    // ── auth config (injected into ctx via services) ────────────
    const dmPolicy = account.dmPolicy ?? 'pairing';

    // ── assemble router ──────────────────────────────────────
    const router = new Router();
    router.use('/message', intentDetection, historyContext, inFlightSteer, authGate, messageHandler);
    router.use('/call', historyContext, authGate, callHandler);

    // ── unified dispatch — the only router.process call site ──
    function route(path, opts) {
        const groupName = opts.groupId;
        const groupIdentity = groupName ? resolveAgentIdentityForGroup(cfg, groupName) : { identity: { name: 'AgentThere' } };
        const agentProfile = { name: groupIdentity.identity?.name, agent: true };
        // if (groupIdentity.identity?.avatar) agentProfile.avatar = groupIdentity.identity.avatar;
        const presetBubble = Boolean(opts.presetMsgId);
        const msgId = opts.presetMsgId ?? createMessageId();
        const res = new OutboundResponse({
            mode: 'group',
            groupId: opts.groupId,
            agentFrom: agentProfile,
            msgId,
            presetBubble,
            monitor: opts.monitor,
            peerId: opts.peerId,
            getPeerIds: opts.monitor ? () => opts.monitor.getPeerIds() : undefined
        });
        const groupSkillFilter = resolveGroupSkillFilter(cfg, groupName);
        const groupSystemPrompt = resolveGroupSystemPrompt(cfg, groupName);
        const groupAgentId = resolveGroupOpenClawAgentId(cfg, groupName);
        const verbose = resolveGroupVerbose(runtime.config.current(), groupName);

        // Pre-resolve group route with agent binding — handlers just read ctx.routedSessionKey / ctx.routedAccountId.
        let routedSessionKey;
        let routedAccountId;
        if (groupName) {
            const groupPeer = { kind: 'group', id: String(groupName) };
            const bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];
            const overrideCfg = {
                ...cfg,
                bindings: [
                    { agentId: groupAgentId, match: { channel: 'agentthere', accountId: account.accountId, peer: groupPeer } },
                    ...bindings
                ]
            };
            const resolved = runtime.channel.routing.resolveAgentRoute({
                cfg: overrideCfg,
                channel: 'agentthere',
                accountId: account.accountId,
                peer: groupPeer
            });
            routedSessionKey = resolved.sessionKey;
            routedAccountId = resolved.accountId;
        }

        return router.process(path, {
            ...opts,
            ...createContext({
                ...opts,
                runtime,
                cfg,
                accountId: account.accountId,
                abortSignal,
                path,
                res,
                msgId,
                agentProfile,
                presetBubble,
                groupSkillFilter,
                groupSystemPrompt,
                groupAgentId,
                verbose,
                routedSessionKey,
                routedAccountId
            }),
            ...services
        });
    }

    // ── exec re-dispatch ────────────────────────────────────────
    const redispatchForGroup = (groupId, text) => {
        const followupPrompt = [
            'An async command the user already approved has completed.',
            'Do not run the command again.',
            '',
            'Exact completion details:',
            text.trim(),
            '',
            'Reply to the user in a helpful way.',
            'If it succeeded, share the relevant output.',
            'If it failed, explain what went wrong.'
        ].join('\n');

        route('/message', {
            peerId: 'system',
            peerName: 'system',
            uid: 'system',
            groupId,
            text: followupPrompt,
            cleanText: followupPrompt
        });
    };
    for (const gid of resolveConfiguredGroupIds(account)) {
        groupDispatchHandlers.set(gid, redispatchForGroup);
    }

    // ── shared services (placed on every ctx) ───────────────────
    const services = {
        route,
        dmPolicy,
        allowFrom: account.allowFrom ?? [],
        log: console
    };

    // ── WEBRTC settings (from openclaw.json account config) ─────
    const activeMqtt = account.mqtt;
    const accountId = account.accountId;

    const { connect: _connect } = await import('mqtt');
    const sharedClient = activeMqtt ? _connect(activeMqtt.url, {
        clientId: `openclaw-${accountId}-${randomUUID().slice(0, 8)}`,
        username: activeMqtt.username,
        password: activeMqtt.password,
        reconnectPeriod: 3000,
        keepalive: 120,
    }) : null;

    // ── dynamic group monitor management ─────────────────────────
    const activeMonitors = new Map(); // groupId → { cleanup, identityRef, identityWatcher, monitor }

    async function startGroupMonitorFor(groupId) {
        if (activeMonitors.has(groupId) || !activeMqtt) return;

        const identityRef = { current: resolveAgentIdentityForGroup(cfg, groupId) };
        console.info(`[${accountId}] joining AgentThere group "${groupId}" as "${identityRef.current.identity?.name}"`);

        const monitor = await startGroupMonitor({
            client: sharedClient,
            groupId,
            agentId: identityRef.current.agentId,
            identity: () => identityRef.current.identity,
            abortSignal
        }).catch(err => {
            console.error(`[${accountId}] failed to join group "${groupId}": ${String(err)}`);
            return { cleanup: () => {} };
        });

        // ── watch IDENTITY.md for changes, re-resolve and broadcast ──
        let identityWatcher = null;
        try {
            const wsDir = resolveAgentWorkspaceDir(cfg, identityRef.current.agentId);
            const identityFile = path.join(wsDir, 'IDENTITY.md');
            identityWatcher = fs.watch(identityFile, _evt => {
                identityRef.current = resolveAgentIdentityForGroup(cfg, groupId);
                monitor.broadcastProfile?.();
            });
            identityWatcher.on?.('error', () => {
                try {
                    identityWatcher?.close();
                } catch {
                    /* ignore */
                }
            });
        } catch {
            // fs.watch unsupported or workspace not resolvable — skip
        }

        const monitorCleanup = typeof monitor === 'function' ? monitor : monitor.cleanup;
        const wrappedCleanup = () => {
            try {
                identityWatcher?.close();
            } catch {
                /* ignore */
            }
            monitorCleanup();
        };

        // ── wire message handlers ──────────────────────────────────
        monitor.setOnRawMessage((raw, peer) => {
            const peerId = peer.peerId;
            const peerName = peer.peerName;

            let parsed;
            try {
                parsed = JSON.parse(raw);
            } catch {
                parsed = { text: raw };
            }

            if (parsed.type === 'profile') {
                const profile = parsed.profile;
                console.log(`[agentthere/rtc:${peer.groupId}] profile update from ${peerId}: name=${profile?.name} uid=${parsed?.uid}`);
                if (profile?.name && peer) peer.peerName = profile.name;
                if (parsed?.uid && peer) peer.uid = parsed.uid;
                return;
            }

            const msgUid = parsed.uid ?? peer?.uid ?? null;
            if (parsed.uid && peer) peer.uid = parsed.uid;

            if (parsed.file && parsed.object_id) {
                registerIncomingFile(parsed);
                return;
            }

            const peerCount = getGroupPeers(groupId).length;
            let messageOpts = null;

            if (parsed.chunk && parsed.object_id) {
                const completed = handleIncomingChunk(parsed);
                if (!completed) return;

                const savedPath = persistInboundFile(completed.fileName, completed.buffer);
                console.log(`[agentthere/rtc:${peer.groupId}] file received from ${peerId}: ${completed.fileName} (${completed.size} bytes) → ${savedPath}`);
                const label = `[File received: ${completed.fileName} (${completed.mimeType})]`;
                messageOpts = {
                    text: label,
                    cleanText: label,
                    mediaUrl: `file://${savedPath}`,
                    fileName: completed.fileName,
                    mimeType: completed.mimeType
                };
            } else {
                const text = parsed.text != null ? String(parsed.text).trim() : '';
                if (!text) return;
                console.log(`[agentthere/rtc:${peer.groupId}] message from ${peerId} (peers=${peerCount}): ${text}`);
                messageOpts = { text, cleanText: text };
            }

            route('/message', {
                peerId,
                peerName,
                uid: msgUid,
                groupId,
                peerCount,
                ...messageOpts
            });
        });

        monitor.setOnInboundStream((streamHandle, peer) => {
            route('/call', {
                peerName: peer.peerName,
                uid: peer.uid,
                groupId,
                peerId: peer.peerId,
                streamHandle,
                monitor,
                runtime,
                abortSignal,
                mentioned: true
            });
        });

        groupDispatchHandlers.set(groupId, redispatchForGroup);
        activeMonitors.set(groupId, { cleanup: wrappedCleanup, identityRef, identityWatcher, monitor });
    }

    function stopGroupMonitor(groupId) {
        const entry = activeMonitors.get(groupId);
        if (!entry) return;
        console.info(`[${accountId}] stopping AgentThere group "${groupId}"`);
        entry.cleanup();
        activeMonitors.delete(groupId);
        groupDispatchHandlers.delete(groupId);
    }

    // ── initial group setup ───────────────────────────────────────
    const configuredGroupIds = resolveConfiguredGroupIds(account);

    if (activeMqtt && configuredGroupIds.length > 0 && sharedClient) {
        await new Promise((resolve, reject) => {
            if (sharedClient.connected) return resolve();
            sharedClient.once('connect', resolve);
            sharedClient.once('error', reject);
        });
        for (const groupId of configuredGroupIds) {
            await startGroupMonitorFor(groupId);
        }
    } else if (configuredGroupIds.length > 0) {
        console.warn(`[${accountId}] groups configured but no mqtt broker set`);
    }

    ctx.setStatus({ accountId, running: true, connected: true, groups: configuredGroupIds });

    // ── poll for group config changes (hot-reload without restart) ─
    const GROUP_POLL_INTERVAL_MS = 15_000;
    let pollRunning = false;
    const groupPollTimer = setInterval(() => {
        if (abortSignal.aborted || pollRunning) return;
        pollRunning = true;
        try {
            const freshCfg = runtime.config.current();
            cfg = freshCfg;
            const freshAccount = resolveAccount(freshCfg, accountId);
            const freshGroups = resolveConfiguredGroupIds(freshAccount);
            const currentGroups = new Set(activeMonitors.keys());

            for (const gid of freshGroups) {
                if (!currentGroups.has(gid)) {
                    startGroupMonitorFor(gid).catch(err =>
                        console.error(`[${accountId}] dynamic group start failed for "${gid}": ${String(err)}`)
                    );
                }
            }

            for (const gid of currentGroups) {
                if (!freshGroups.includes(gid)) {
                    stopGroupMonitor(gid);
                }
            }
        } catch {
            // loadConfig may fail transiently — skip this poll cycle
        } finally {
            pollRunning = false;
        }
    }, GROUP_POLL_INTERVAL_MS);
    groupPollTimer.unref();

    // ── wait for shutdown ──────────────────────────────────────────
    await new Promise(resolve => {
        abortSignal.addEventListener('abort', resolve, { once: true });
    });

    console.info(`[${accountId}] stopping AgentThere channel`);
    clearInterval(groupPollTimer);
    for (const groupId of [...activeMonitors.keys()]) {
        stopGroupMonitor(groupId);
    }
    sharedClient?.end();

    ctx.setStatus({ accountId, running: false, connected: false });
}
