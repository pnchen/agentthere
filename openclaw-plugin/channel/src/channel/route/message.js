/**
 * Encapsulated reply pipeline.
 *
 * Takes a fully-prepared `ctx` (req + res + injected services) and runs the
 * agent dispatch end-to-end. All streaming, tool-tracking, reasoning, usage,
 * and lifecycle details are internal — callers only get back a clean result.
 *
 * This is the terminal operation called by the /message dispatch middleware.
 */

import { onInternalDiagnosticEvent } from 'openclaw/plugin-sdk/diagnostic-runtime';
import { isReasoningReplyPayload, resolveOutboundMediaUrls } from 'openclaw/plugin-sdk/reply-payload';

// ── middleware entry point ───────────────────────────────────────────

export async function messageHandler(ctx, next) {
    const res = ctx.res;
    const msgId = ctx.msgId;
    const presetBubble = ctx.presetBubble;
    const agentFrom = ctx.agentProfile;
    const cfg = ctx.cfg;
    const accountId = ctx.accountId;
    const abortSignal = ctx.abortSignal;
    const runtime = ctx.runtime;

    const groupName = ctx.groupId;
    const peerId = ctx.peerId;
    const uid = ctx.uid;
    const name = ctx.peerName;
    const text = ctx.getCombinedBody?.(ctx.cleanText);
    console.log(`[agentthere:recv] ${Date.now()} msgId=${msgId} peerId=${peerId ?? '-'} group=${groupName ?? '-'} text="${text}"`);
    const round = res.current;
    // ── resolve config ─────────────────────────────────────────
    const groupSkillFilter = ctx.groupSkillFilter;
    const configuredGroupPrompt = ctx.groupSystemPrompt;

    const identityHint = groupName
        ? `In AgentThere group "${groupName}", your display identity is "${ctx.agentProfile?.name ?? 'AgentThere'}". Use this name when referring to yourself in replies for this group.`
        : undefined;
    const groupSystemPrompt = [configuredGroupPrompt, identityHint].filter(Boolean).join('\n\n') || undefined;

    // ── route resolution ──────────────────────────────────────
    const peer = groupName ? { kind: 'group', id: String(groupName) } : { kind: 'direct', id: String(uid || peerId || name) };

    const route = groupName
        ? { sessionKey: ctx.routedSessionKey, accountId: ctx.routedAccountId }
        : runtime.channel.routing.resolveAgentRoute({ cfg, channel: 'agentthere', accountId, peer });

    // ── build inbound context ─────────────────────────────────
    const fallbackSessionKey = groupName ? `agentthere:group:${groupName}` : `agentthere:${route.accountId}:${peerId ?? name}`;
    const replyTarget = groupName
        ? `agentthere:group:${groupName}`
        : [peerId, uid, name].find(v => typeof v === 'string' && v.trim().length > 0)?.trim();

    const msgCtx = {
        Provider: 'agentthere',
        Surface: 'agentthere',
        From: groupName ? `agentthere:group:${groupName}` : name,
        To: replyTarget ?? route.accountId,
        SenderId: uid ?? null,
        SenderName: name,
        Body: text,
        RawBody: text,
        ChatType: groupName ? 'group' : 'direct',
        SessionKey: route.sessionKey ?? fallbackSessionKey,
        AccountId: route.accountId,
        ConversationLabel: groupName ? `AgentThere/${groupName}` : `agentthere:${name}`,
        GroupSubject: groupName,
        GroupSystemPrompt: groupSystemPrompt,
        CommandAuthorized: true
    };

    if (ctx.mediaUrl) {
        msgCtx.MediaPath = ctx.mediaUrl;
        msgCtx.MediaUrl = ctx.mediaUrl;
        msgCtx.MediaType = ctx.mimeType ?? 'application/octet-stream';
        msgCtx.MediaPaths = [ctx.mediaUrl];
        msgCtx.MediaUrls = [ctx.mediaUrl];
        msgCtx.MediaTypes = [msgCtx.MediaType];
    }

    console.log(
        `[agentthere:disp] ${Date.now()} start msgId=${msgId} sessionKey=${route.sessionKey} ` +
            `peerId=${peerId ?? '-'} group=${groupName ?? '-'}`
    );

    // ── usage subscription ────────────────────────────────────
    const unsubUsage = onInternalDiagnosticEvent((evt, _meta) => {
        if (evt.type !== 'model.usage') return;
        if (evt.sessionKey !== msgCtx.SessionKey) return;
        round.sendUsage(evt);
    });

    // ── reply pipeline ────────────────────────────────────────
    const rpc = runtime.channel.reply.createReplyDispatcherWithTyping({
        deliver: async (payload, info) => {
            round.sendPlaceholder();
            const replyText = payload?.text ?? '';
            const kind = info?.kind;
            console.log(`[agentthere:deliver] msgId=${msgId} kind=${kind ?? '-'} text="${replyText}" payload=`, payload);
            const mediaUrls = resolveOutboundMediaUrls(payload ?? {});

            if (mediaUrls.length > 0 || /(^|\n)\s*MEDIA[:\s]/i.test(replyText)) {
                round.mediaTokenSeen = true;
            }

            // ── send media files ───────────────────────────
            for (const rawUrl of mediaUrls) {
                const dedupKey = round.stageMediaKey(rawUrl);
                if (round.sentMediaKeys.has(dedupKey)) continue;
                round.sentMediaKeys.add(dedupKey);
                try {
                    await round.sendMedia({
                        rawUrl,
                        kind: payload?.audioAsVoice ? 'voice' : undefined,
                        groupId: groupName,
                        peerId
                    });
                } catch (err) {
                    console.error(`[agentthere:file] send failed: ${String(err)}`);
                }
            }

            // ── tool result ────────────────────────────────
            if (kind === 'tool') {
                const toolCallId = info?.toolCallId ?? info?.itemId ?? payload?.toolCallId ?? payload?.itemId;
                const segPath = toolCallId
                    ? 'segments[toolCallId=' + toolCallId + ']'
                    : round.lastToolSid
                      ? 'segments[sid=' + round.lastToolSid + ']'
                      : null;
                if (segPath) {
                    const mergeValue = { phase: 'end' };
                    if (replyText && mediaUrls.length === 0) mergeValue.result = replyText;
                    round.send({ id: msgId, _patch: [{ op: 'merge', path: segPath, value: mergeValue }] });
                }
                return;
            }
            if (round.streamed && replyText) return;
            if (replyText) {
                if (isReasoningReplyPayload(payload ?? {})) {
                    round.lastReasoningText = replyText;
                    round.send({ id: msgId, _patch: [{ op: 'append_text', path: 'reasoning', chunk: replyText }] });
                } else {
                    const sid = round.ensureTextSegment();
                    round.send({ id: msgId, _patch: [{ op: 'append_text', path: 'segments[sid=' + sid + '].text', chunk: replyText }] });
                }
                round.streamed = true;
            }
        },
        onError: err => {
            console.error(`[agentthere:deliver:error] peerId=${peerId}: ${String(err)}`);
        },
        onSkip: () => {}
    });

    // ── build dispatch options ───────────────────────────────
    const replyOptions = {
        ...rpc.replyOptions,
        ...(groupSkillFilter ? { skillFilter: groupSkillFilter } : {}),
        sourceReplyDeliveryMode: 'automatic',
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
        suppressDefaultToolProgressMessages: ctx.verbose === 'on' || ctx.verbose === 'full',
        abortSignal,

        onBlockReply: payload => {
            round.sendPlaceholder();
            rpc.dispatcher.sendBlockReply(payload);
        },

        onPartialReply: payload => {
            // console.log(`[PAN-DEBUG] onPartialReply fired msgId=${msgId} text=${payload.text?.slice(0, 50)}`);
            const accText = payload.text ?? '';
            if (!accText) return;
            round.sendPlaceholder();

            let safeAccText = accText;
            const mediaMatch = accText.match(/(^|\n)\s*MEDIA[:\s]/i);
            if (mediaMatch) {
                round.mediaTokenSeen = true;
                const cutAt = mediaMatch.index + mediaMatch[1].length;
                safeAccText = accText.slice(0, cutAt).replace(/\s+$/, '');
            }

            if (safeAccText.length <= round.lastAccText.length) return;
            let delta;
            if (safeAccText.startsWith(round.lastAccText)) {
                delta = safeAccText.slice(round.lastAccText.length);
            } else {
                delta = (round.lastAccText ? '\n\n' : '') + safeAccText;
            }
            round.lastAccText = safeAccText;
            round.streamed = true;

            const visibleDelta = delta.replace(/\[\[\s*(?:tts|stt)\s*:[^\]]*\]\]/gi, '');
            if (!visibleDelta) return;

            const sid = round.ensureTextSegment();
            round.send({ id: msgId, _patch: [{ op: 'append_text', path: 'segments[sid=' + sid + '].text', chunk: visibleDelta }] });
        },

        onToolStart: payload => {
            round.sendPlaceholder();
            const argsObj = payload.args && typeof payload.args === 'object' ? payload.args : undefined;
            let argsSummary = '';
            if (argsObj) {
                const a = argsObj;
                if (typeof a.path === 'string') argsSummary = a.path;
                else if (typeof a.file_path === 'string') argsSummary = a.file_path;
                else if (typeof a.command === 'string') argsSummary = a.command;
                else if (typeof a.pattern === 'string') argsSummary = a.pattern;
                else if (typeof a.url === 'string') argsSummary = a.url;
                else if (typeof a.query === 'string') argsSummary = a.query;
                if (!argsSummary) {
                    for (const k of Object.keys(a)) {
                        const v = a[k];
                        if (typeof v === 'string' && v.length > 0) {
                            argsSummary = v;
                            break;
                        }
                    }
                }
            }
            round.sealTextSegment();
            const sid = round.nextSid();
            round.lastToolSid = sid;
            round.send({
                id: msgId,
                _patch: [
                    {
                        op: 'push',
                        path: 'segments',
                        value: {
                            sid,
                            kind: 'tool',
                            toolCallId: payload.toolCallId ?? payload.itemId,
                            name: payload.name ?? 'unknown',
                            args: argsObj,
                            argsSummary: argsSummary || undefined,
                            events: []
                        }
                    }
                ]
            });
        },

        onCommandOutput: payload => {
            if (!round.lastToolSid) return;
            round.sendPlaceholder();
            round.send({
                id: msgId,
                _patch: [
                    {
                        op: 'push',
                        path: 'segments[sid=' + round.lastToolSid + '].events',
                        value: {
                            kind: 'command',
                            itemId: payload.itemId,
                            toolCallId: payload.toolCallId,
                            name: payload.name,
                            title: payload.title,
                            phase: payload.phase,
                            status: payload.status,
                            output: payload.output,
                            exitCode: payload.exitCode,
                            durationMs: payload.durationMs,
                            cwd: payload.cwd
                        }
                    }
                ]
            });
        },

        onPatchSummary: payload => {
            if (payload.phase !== 'end') return;
            if (!round.lastToolSid) return;
            round.sendPlaceholder();
            round.send({
                id: msgId,
                _patch: [
                    {
                        op: 'push',
                        path: 'segments[sid=' + round.lastToolSid + '].events',
                        value: {
                            kind: 'patch',
                            itemId: payload.itemId,
                            toolCallId: payload.toolCallId,
                            name: payload.name,
                            title: payload.title,
                            phase: payload.phase,
                            added: payload.added,
                            modified: payload.modified,
                            deleted: payload.deleted,
                            summary: payload.summary
                        }
                    }
                ]
            });
        },

        onItemEvent: payload => {
            console.log('[agentthere:itemEvent]', JSON.stringify(payload));
            const phase = payload?.phase;
            const kind = payload?.kind;
            const isToolItem = !kind || kind === 'tool' || kind === 'command' || kind === 'exec' || kind === 'patch' || kind === 'edit';
            if (!isToolItem) return;
            round.sendPlaceholder();
            if (phase === 'start') {
                if (!round.lastToolSid) return;
                round.pendingToolSids.push(round.lastToolSid);
                round.send({ id: msgId, _patch: [{ op: 'merge', path: 'segments[sid=' + round.lastToolSid + ']', value: { phase } }] });
                return;
            }
            if (phase === 'end' || phase === 'completed' || phase === 'error') {
                round.markOldestToolPhase(phase);
            }
        },

        onReasoningStream: payload => {
            const accText = payload.text ?? '';
            if (!accText) return;
            round.sendPlaceholder();
            let delta;
            if (accText.length > round.lastReasoningText.length && accText.startsWith(round.lastReasoningText)) {
                delta = accText.slice(round.lastReasoningText.length);
            } else {
                delta = accText;
            }
            round.lastReasoningText = accText;
            round.send({ id: msgId, _patch: [{ op: 'append_text', path: 'reasoning', chunk: delta }] });
        },

        onReasoningEnd: () => {
            round.lastReasoningText = '';
            round.sendPlaceholder();
            round.send({ id: msgId, _patch: [{ op: 'set', path: 'reasoning_complete', value: true }] });
        },

        onModelSelected: info => {
            round.sendPlaceholder();
            round.send({ id: msgId, model_info: { model: info.model, provider: info.provider, thinkLevel: info.thinkLevel } });
        }
    };

    try {
        await runtime.channel.reply.dispatchReplyFromConfig({
            ctx: runtime.channel.reply.finalizeInboundContext(msgCtx),
            cfg,
            dispatcher: rpc.dispatcher,
            replyOptions
        });
        if (round.mediaTokenSeen && round.sentMediaKeys.size === 0) {
            round.sendNote('⚠️ File not sent: core not authorized or file not found. Try a different path or copy it to the workspace first.');
        }
    } catch (err) {
        console.error(`[agentthere] dispatch failed for peerId=${peerId}: ${String(err)}`);
        round.closeLoading({ error: String(err?.message ?? err) });
    } finally {
        rpc.markDispatchIdle();
        unsubUsage();
        round.closeLoading();
    }
}
