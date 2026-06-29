import { formatAllowFromLowercase } from 'openclaw/plugin-sdk/allow-from';
import { buildDmGroupAccountAllowlistAdapter } from 'openclaw/plugin-sdk/allowlist-config-edit';
import { adaptScopedAccountAccessor, createScopedChannelConfigAdapter } from 'openclaw/plugin-sdk/channel-config-helpers';
import { resolveOutboundMediaUrls } from 'openclaw/plugin-sdk/reply-payload';
import {
    buildBaseChannelStatusSummary,
    createComputedAccountStatusAdapter,
    createDefaultChannelRuntimeState
} from 'openclaw/plugin-sdk/status-helpers';

import { listAccountIds, resolveAccount, resolveAgentIdentityForGroup } from './config.js';
import { sendMedia } from './channel/file-send.js';
import { resolveChannelGroupRequireMention, resolveChannelGroupToolsPolicy } from 'openclaw/plugin-sdk/channel-policy';
import {
    buildOutboundTextMessage,
    createMessageId,
    formatTargetDisplay,
    looksLikeTargetId,
    normalizeMessagingTarget,
    parseMessagingTarget,
    resolveOutboundSessionRoute
} from './channel/messaging.js';
import { getRuntime } from './runtime.js';
import { getGroupPeers, getPeerByPeerId } from './channel/rtc/index.js';

const EXEC_FOLLOWUP_RE = /^Exec (?:finished|denied) \(/;

import { groupDispatchHandlers } from './channel/start-account.js';
import { startAccount } from './channel/start-account.js';
import { collectStatusIssues, probeAgentThere, resolveConfiguredGroupIds } from './channel/status.js';

function buildAgentProfile(identity) {
    return { ...identity, agent: true, name: identity?.name ?? 'OpenClaw Agent' };
}

console.error('[agentthere:plugin] loading agenttherePlugin module');

export const agenttherePlugin = {
    id: 'agentthere',

    meta: {
        id: 'agentthere',
        label: 'AgentThere',
        selectionLabel: 'AgentThere',
        docsPath: '/channels/agentthere',
        blurb: 'Browser-to-agent channel via WebRTC DataChannel + MQTT signaling + STUN/TURN NAT traversal'
    },

    capabilities: {
        chatTypes: ['direct', 'group'],
        media: true,
        tts: {
            voice: {
                synthesisTarget: 'voice-note',
                transcodesAudio: true
            }
        }
    },

    reload: {
        configPrefixes: ['channels.agentthere'],
        noopPrefixes: ['channels.agentthere.groups']
    },

    config: {
        ...createScopedChannelConfigAdapter({
            sectionKey: 'agentthere',
            listAccountIds: listAccountIds,
            resolveAccount: adaptScopedAccountAccessor(({ cfg, accountId }) => resolveAccount(cfg, accountId)),
            defaultAccountId: () => undefined,
            clearBaseFields: ['mqtt', 'ice_servers'],
            resolveAllowFrom: account => account.allowFrom,
            formatAllowFrom: allowFrom => formatAllowFromLowercase({ allowFrom: allowFrom ?? [] }),
            allowTopLevel: true
        }),

        isEnabled(account) {
            return account.enabled;
        },

        isConfigured(account) {
            return Boolean(account.mqtt?.url || resolveConfiguredGroupIds(account).length > 0);
        },

        unconfiguredReason(account) {
            if (!account.mqtt?.url && resolveConfiguredGroupIds(account).length === 0) {
                return 'MQTT signaling URL or groups not configured';
            }
            return undefined;
        },

        describeAccount(account) {
            return {
                accountId: account.accountId,
                enabled: account.enabled,
                configured: Boolean(account.mqtt?.url),
                dmPolicy: account.dmPolicy,
                allowFrom: account.allowFrom,
                signalingUrl: account.mqtt?.url ?? null
            };
        }
    },

    status: createComputedAccountStatusAdapter({
        defaultRuntime: createDefaultChannelRuntimeState(''),
        probeAccount: async ({ account, timeoutMs }) => await probeAgentThere(account, timeoutMs),
        collectStatusIssues: accounts => collectStatusIssues(accounts),
        buildChannelSummary: ({ snapshot }) =>
            buildBaseChannelStatusSummary(snapshot, {
                signalingConfigured: snapshot.signalingConfigured ?? false,
                activeSessions: snapshot.activeSessions ?? 0,
                groupCount: snapshot.groupCount ?? 0
            }),
        resolveAccountSnapshot: ({ account, probe }) => {
            const groupIds = resolveConfiguredGroupIds(account);
            return {
                accountId: account.accountId,
                name: account.identity?.name,
                enabled: account.enabled,
                configured: Boolean(account.mqtt?.url),
                extra: {
                    dmPolicy: account.dmPolicy,
                    groupCount: groupIds.length,
                    groups: groupIds,
                    signalingConfigured: Boolean(account.mqtt?.url),
                    signalingUrl: probe?.signaling?.url ?? account.mqtt?.url ?? null,
                    activeSessions: typeof probe?.activeSessions === 'number' ? probe.activeSessions : 0
                }
            };
        }
    }),

    security: {
        resolveDmPolicy({ account }) {
            return {
                policy: account.dmPolicy ?? 'pairing',
                allowFrom: account.allowFrom ?? [],
                policyPath: 'channels.agentthere.dmPolicy',
                allowFromPath: 'channels.agentthere.allowFrom',
                approveHint: 'openclaw pairing approve agentthere <code>',
                normalizeEntry: raw => String(raw).trim().toLowerCase()
            };
        }
    },

    pairing: {
        idLabel: 'agentthereUid',
        normalizeAllowEntry: entry => String(entry).trim().toLowerCase()
    },

    allowlist: buildDmGroupAccountAllowlistAdapter({
        channelId: 'agentthere',
        resolveAccount: ({ cfg, accountId }) => resolveAccount(cfg, accountId),
        normalize: ({ allowFrom }) => formatAllowFromLowercase({ allowFrom: allowFrom ?? [] }),
        resolveDmAllowFrom: account => account.allowFrom,
        resolveGroupAllowFrom: _account => undefined,
        resolveDmPolicy: account => account.dmPolicy
    }),

    groups: {
        resolveRequireMention: params => resolveChannelGroupRequireMention({ ...params, channel: 'agentthere' }),
        resolveToolPolicy: params => resolveChannelGroupToolsPolicy({ ...params, channel: 'agentthere' })
    },

    agentPrompt: {
        messageToolHints: () => [
            '- AgentThere channel supports sending files and images as attachments, in both DMs and groups.',
            '- To send a file in your reply, put a single line `MEDIA:<absolute-path-or-url>` in your response text. The gateway strips that line before delivery and sends the actual file to all peers.',
            '- Received files appear in history as `[附件: <name>]` followed by a ready-to-copy `MEDIA:<path>` line. When asked to resend a file, copy that `MEDIA:...` line VERBATIM into your reply (do not retype the filename, do not translate, do not wrap it in quotes or backticks).',
            '- File paths may contain non-ASCII characters, spaces, or punctuation — copy them byte-for-byte exactly as shown in history.',
            '- HTTP/HTTPS URLs also work: `MEDIA:https://example.com/file.pdf`.',
            '- Supported formats: images (png/jpg/gif/webp), audio (mp3/ogg/wav/flac), video (mp4/webm/mov), documents (pdf/zip/stl), and any other file type.',
            '- Never emit the word `MEDIA` alone or start a `MEDIA:` line you cannot finish — if you are unsure of the exact path, do not mention MEDIA at all.',
            '- Voice interaction controls use `[[stt:...]]` directives embedded in your reply:',
            '- `[[stt:silence=N]]` (N=2000-6000ms): extend speech recognition silence timeout. Use when the user says things like "let me think", "hold on", "don\'t rush" — append this to give them more time before the system finalizes their speech.',
            '- `[[stt:tts_break]]`: immediately stop your outgoing voice playback so the user can speak uninterrupted. Use when the user says things like "stop talking", "let me speak", "listen to me first".',
            '- Both directives are stripped from the visible reply text and only affect audio behavior. Never mention them to the user or explain what they do.'
        ]
    },

    messaging: {
        normalizeTarget: normalizeMessagingTarget,
        formatTargetDisplay: params => formatTargetDisplay(params),
        resolveOutboundSessionRoute: params => resolveOutboundSessionRoute(params),
        targetResolver: {
            looksLikeId: looksLikeTargetId,
            hint: '<peer-id|#group>'
        }
    },

    outbound: {
        deliveryMode: 'direct',

        sendText: async ctx => {
            const { to, text } = ctx;
            const parsedTarget = parseMessagingTarget(to);

            if (EXEC_FOLLOWUP_RE.test(text) && parsedTarget?.kind === 'group') {
                const handler = groupDispatchHandlers.get(parsedTarget.id);
                if (handler) {
                    console.error(`[agentthere:sendText] intercepted exec follow-up for group=${parsedTarget.id}, re-dispatching to agent`);
                    void handler(parsedTarget.id, text);
                    return {
                        channel: 'agentthere',
                        messageId: `exec-followup-${Date.now()}`,
                        ok: true
                    };
                }
            }

            const peerId = parsedTarget?.kind === 'direct' ? parsedTarget.id : to;
            const peer = getPeer(peerId);
            let agentProfile;
            if (parsedTarget?.kind === 'group') {
                const identity = resolveAgentIdentityForGroup(ctx.cfg ?? {}, parsedTarget.id);
                agentProfile = buildAgentProfile(identity.identity);
            } else if (peer?.sessionMode === 'group') {
                agentProfile = buildAgentProfile(peer.agent.profile);
            } else {
                agentProfile = buildAgentProfile();
            }

            // FIXME: in-flight folding removed — `lookupInFlightForTarget` was the last inflight consumer.
            // Core-triggered `sendText` during an active agent reply was folded into the running bubble.
            // If outbound text arrives mid-reply and creates a visible duplicate bubble, reconsider.
            // const groupNameForLookup = parsedTarget?.kind === 'group' ? parsedTarget.id : undefined;
            // const peerIdForLookup = parsedTarget?.kind === 'direct' ? parsedTarget.id : undefined;
            // const inFlight = lookupInFlightForTarget({
            //     groupName: groupNameForLookup,
            //     peerId: peerIdForLookup
            // });
            // if (inFlight) {
            //     const update = {
            //         id: inFlight.msgId,
            //         text_chunk: text,
            //         from: inFlight.agentProfile
            //     };
            //     const payload = JSON.stringify(update);
            //     const ok = parsedTarget?.kind === 'group' ? sendTextToGroup(parsedTarget.id, payload) : sendToPeer(peerId, payload);
            //     if (!ok) {
            //         getRuntime().error?.(`[agentthere] sendText (in-flight fold): target ${to} not connected or DataChannel not open`);
            //     }
            //     return { channel: 'agentthere', messageId: inFlight.msgId, ok };
            // }

            const outboundMessage = buildOutboundTextMessage({ text, agentProfile });
            const payload = JSON.stringify(outboundMessage);
            let ok;
            if (parsedTarget?.kind === 'group') {
                const groupList = getGroupPeers(parsedTarget.id);
                ok = false;
                for (const p of groupList) {
                    if (p.send(payload)) ok = true;
                }
            } else {
                ok = getPeerByPeerId(peerId)?.send(payload) ?? false;
            }
            if (!ok) {
                getRuntime().error?.(`[agentthere] sendText: target ${to} not connected or DataChannel not open`);
            }
            return {
                channel: 'agentthere',
                messageId: outboundMessage.id,
                ok
            };
        },

        sendMedia: async ctx => {
            const { to, text, mediaUrl } = ctx;
            if (!mediaUrl) return agenttherePlugin.outbound.sendText(ctx);

            const parsedTarget = parseMessagingTarget(to);
            const peerId = parsedTarget?.kind === 'direct' ? parsedTarget.id : to;
            const peer = getPeerByPeerId(peerId);

            const groupIdentity = parsedTarget?.kind === 'group' ? resolveAgentIdentityForGroup(ctx.cfg ?? {}, parsedTarget.id) : null;
            const agentProfile = buildAgentProfile(groupIdentity?.identity ?? peer?.agent.profile);

            let delivery = { ok: false, messageId: createMessageId() };
            try {
                delivery = await sendMedia({
                    rawUrl: mediaUrl,
                    groupId:
                        parsedTarget?.kind === 'group' ? parsedTarget.id : peer?.sessionMode === 'group' ? peer.groupId : undefined,
                    peerId,
                    agentProfile
                });
            } catch (err) {
                getRuntime().error?.(`[agentthere] sendMedia failed for peer ${to}: ${String(err)}`);
            }

            if (text && text.trim()) {
                const txtPayload = JSON.stringify(buildOutboundTextMessage({ text, agentProfile }));
                if (parsedTarget?.kind === 'group') {
                    const groupList = getGroupPeers(parsedTarget.id);
                    for (const p of groupList) p.send(txtPayload);
                } else {
                    getPeerByPeerId(peerId)?.send(txtPayload);
                }
            }

            return {
                channel: 'agentthere',
                messageId: delivery.messageId,
                ok: delivery.ok
            };
        }
    },

    gateway: {
        startAccount: startAccount
    }
};
