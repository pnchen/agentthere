/**
 * Voice call route handler.
 *
 * Processes an inbound audio stream as a continuous per-peer flow:
 * Opus → PCM → realtime voice bridge → STT → direct agent dispatch.
 * Also handles TTS synthesis and playback for agent replies.
 *
 * One stream per peer (not per track). The handler runs for the lifetime
 * of the peer connection and cleans up when the stream closes (peer
 * disconnect). Mic on/off toggles just affect which tracks push frames
 * into the stream — the voice bridge session persists across mic cycles.
 *
 */

import { ensureTtsConsumer, closeTtsQueue, cancelTtsQueue, pushTtsDelta, pushTtsFlush } from './tts-queue.js';
import { isReasoningReplyPayload, resolveOutboundMediaUrls } from 'openclaw/plugin-sdk/reply-payload';
import { onInternalDiagnosticEvent } from 'openclaw/plugin-sdk/diagnostic-runtime';

// ── lazy codec imports ─────────────────────────────────────────────

let _decodeOpus;
async function _getDecodeOpus() {
    if (!_decodeOpus) {
        const mod = await import('./opus-codec.js');
        _decodeOpus = mod.decodeOpus;
    }
    return _decodeOpus;
}

const VOICE_PEAK_THRESHOLD = 800;
const _lastVoiceTs = new Map();

const SESSION_IDLE_MS = 30_000;

function isSilentPcm16(buf, threshold = VOICE_PEAK_THRESHOLD) {
    let peak = 0;
    for (let i = 0; i < buf.length - 1; i += 2) {
        const sample = buf.readInt16LE(i);
        const abs = sample < 0 ? -sample : sample;
        if (abs > peak) peak = abs;
        if (peak >= threshold) return false;
    }
    return true;
}

// ── inbound stream handler ─────────────────────────────────────────

/**
 * Returns true when a final STT transcript is likely background-noise
 * artefact rather than real speech — e.g. "。" or "嗯。".
 *
 * Strategy: strip all punctuation/symbols/whitespace; if fewer than 2
 * characters remain, or if every remaining character is a common
 * single-syllable filler (嗯/啊/哦 etc.), treat as noise.
 */
function isNoisyTranscript(text) {
    const core = text.replace(/[\s\p{P}\p{S}]/gu, '');
    if (core.length < 2) return true;
    if (core.length <= 3 && /^[嗯啊哦哈呃额唔呀哎哟喂]{1,3}$/.test(core)) return true;
    return false;
}

/**
 * Process an inbound audio stream as a continuous per-peer flow.
 *
 * One invocation per peer. The handler runs for the lifetime of the
 * peer connection (streamHandle persists across mic toggle cycles),
 * decoding Opus frames and feeding PCM into the voice bridge. When the
 * stream closes (peer disconnects), the loop exits and the voice session
 * is cleaned up.
 */
export async function callHandler(ctx) {
    const { cfg, accountId, groupId, peerId, uid, peerName, streamHandle, runtime, res } = ctx;

    console.log(`[agentthere-audio] ${Date.now()} stream open peerId=${peerId} groupId=${groupId}`);

    // ── session state ─────────────────────────────────────────────
    let session = null;
    let ttsBusy = 0;
    let postVoiceHoldMs = 5000;
    let currentRound = null;
    let idleTimer = null;
    let in_flight_dispatches = 0;

    // ── idle timer ────────────────────────────────────────────────

    function cancelIdleTimer() {
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }
    }

    function armSessionIdleTimer() {
        if (in_flight_dispatches > 0 || ttsBusy > 0 || idleTimer) return;
        idleTimer = setTimeout(() => {
            if (in_flight_dispatches > 0 || ttsBusy > 0) return;
            console.log(`[agentthere:voice] ${Date.now()} session idle timeout for ${peerId}, cleaning up`);
            res.mediaOut.stop();
            res.mediaOut.close();
            try {
                session?.close();
            } catch {
                /* ignore */
            }
            session = null;
            for (const round of res._rounds) {
                round.final();
            }
            _lastVoiceTs.delete(peerId);
            closeTtsQueue(peerId);
            // Close streamHandle LAST — unblocks the for-await loop.
            streamHandle?.close();
        }, SESSION_IDLE_MS);
    }

    // ── transcript → agent dispatch ───────────────────────────────

    async function dispatchVoiceTranscript(text, round) {
        cancelIdleTimer();
        round.lastAccText = '';
        in_flight_dispatches++;
        console.log(
            `[agentthere:voice] ${Date.now()} dispatch start peerId=${peerId} round=${round.msgId} inFlight=${in_flight_dispatches}`
        );

        const route = { sessionKey: ctx.routedSessionKey, accountId: ctx.routedAccountId };

        const combinedBody = ctx.getCombinedBody(text);

        const senderName = peerName;
        const groupSkillFilter = ctx.groupSkillFilter;
        const configuredGroupPrompt = ctx.groupSystemPrompt;
        const identityHint = `In AgentThere group "${groupId}", your display identity is "${ctx.agentProfile?.name ?? 'AgentThere'}". Use this name when referring to yourself in replies for this group.`;
        const noiseHint = [
            'This is a voice conversation. STT may pick up background noise, side conversations, or fragments not directed at you.',
            'If a transcript is unrelated to the ongoing conversation or appears to be the user talking to someone else, you MUST IGNORE it completely.',
            'Do NOT acknowledge it, ask about it, or respond to it in any way.',
            'Only respond to text that is clearly addressing you or continuing the current topic.'
        ].join('\n');
        const voiceOutputHint = [
            'CRITICAL: Your reply will be spoken aloud via TTS. You MUST follow these rules for EVERY reply:',
            '- Wrap ALL spoken content in <voice>...</voice> tags. Content outside these tags is display-only and will NOT be spoken.',
            '- Example: <voice>今天有雨带伞</voice> 降雨概率80%，温度18-22°C → TTS speaks only "今天有雨带伞", the rest is shown on screen only.',
            '- You MAY put supplementary details (numbers, links, file names, code) OUTSIDE the <voice> tags so they appear on screen but are not read aloud.',
            '- Keep spoken content inside <voice> SHORT and CONVERSATIONAL (1-3 sentences, plain prose).',
            '- Inside <voice> tags, NEVER use markdown, lists, code blocks, or technical formatting — speak naturally.'
        ].join('\n');
        const groupSystemPrompt =
            [configuredGroupPrompt, identityHint, noiseHint, voiceOutputHint].filter(Boolean).join('\n\n') || undefined;

        const msgCtx = {
            Provider: 'agentthere',
            Surface: 'agentthere',
            From: `agentthere:group:${groupId}`,
            To: `agentthere:group:${groupId}`,
            SenderId: uid ?? null,
            SenderName: senderName,
            Body: combinedBody,
            RawBody: combinedBody,
            ChatType: 'group',
            SessionKey: route.sessionKey ?? `agentthere:group:${groupId}`,
            AccountId: route.accountId,
            ConversationLabel: `AgentThere/${groupId}`,
            GroupSubject: groupId,
            GroupSystemPrompt: groupSystemPrompt,
            CommandAuthorized: true
        };

        // Cancel any in-progress TTS — new speech takes priority
        cancelTtsQueue(peerId, () => res.mediaOut.stop());

        // ── usage subscription ────────────────────────────────────
        const unsubUsage = onInternalDiagnosticEvent((evt, _meta) => {
            if (evt.type !== 'model.usage') return;
            if (evt.sessionKey !== msgCtx.SessionKey) return;
            round.sendUsage(evt);
        });

        const rpc = runtime.channel.reply.createReplyDispatcherWithTyping({
            deliver: async (payload, info) => {
                round.sendPlaceholder();
                const replyText = payload?.text ?? '';
                const mediaUrls = resolveOutboundMediaUrls(payload ?? {});

                if (mediaUrls.length > 0 || /(^|\n)\s*MEDIA[:\s]/i.test(replyText)) {
                    round.mediaTokenSeen = true;
                }

                // ── send media files ─────────────────────────────────
                for (const rawUrl of mediaUrls) {
                    const dedupKey = round.stageMediaKey(rawUrl);
                    if (round.sentMediaKeys.has(dedupKey)) continue;
                    round.sentMediaKeys.add(dedupKey);
                    try {
                        await round.sendMedia({
                            rawUrl,
                            kind: payload?.audioAsVoice ? 'voice' : undefined,
                            groupId,
                            peerId
                        });
                    } catch (err) {
                        console.error(`[agentthere:voice:file] send failed: ${String(err)}`);
                    }
                }

                if (info?.kind === 'tool') {
                    const toolCallId = info?.toolCallId ?? info?.itemId ?? payload?.toolCallId ?? payload?.itemId;
                    const segPath = toolCallId
                        ? 'segments[toolCallId=' + toolCallId + ']'
                        : round.lastToolSid
                          ? 'segments[sid=' + round.lastToolSid + ']'
                          : null;
                    if (segPath) {
                        const mergeValue = { phase: 'end' };
                        if (replyText && mediaUrls.length === 0) mergeValue.result = replyText;
                        round.send({ _patch: [{ op: 'merge', path: segPath, value: mergeValue }] });
                    }
                    return;
                }
                if (round.streamed && replyText) {
                    console.log(`[agentthere:voice:deliver] already streamed, skipping`);
                    return;
                }
                if (replyText) {
                    if (isReasoningReplyPayload(payload ?? {})) {
                        round.lastReasoningText = replyText;
                        round.send({ _patch: [{ op: 'append_text', path: 'reasoning', chunk: replyText }] });
                    } else {
                        const sid = round.ensureTextSegment();
                        round.send({ _patch: [{ op: 'append_text', path: 'segments[sid=' + sid + '].text', chunk: replyText }] });
                    }
                    round.streamed = true;
                }
            },
            onError: err => {
                console.error(`[agentthere:voice:deliver] ${String(err)}`);
            },
            onSkip: () => {}
        });

        const replyOptions = {
            ...rpc.replyOptions,
            ...(groupSkillFilter ? { skillFilter: groupSkillFilter } : {}),
            sourceReplyDeliveryMode: 'automatic',
            allowProgressCallbacksWhenSourceDeliverySuppressed: true,
            suppressDefaultToolProgressMessages: ctx.verbose === 'on' || ctx.verbose === 'full',

            onBlockReply: payload => {
                round.sendPlaceholder();
                rpc.dispatcher.sendBlockReply(payload);
            },

            onPartialReply: payload => {
                const text = payload.text ?? '';
                if (!text) return;

                const prev = round.lastAccText;
                let delta;
                if (prev && !text.startsWith(prev)) {
                    delta = text;
                } else if (text.length > (prev?.length ?? 0)) {
                    delta = text.slice(prev?.length ?? 0);
                } else {
                    return;
                }
                round.lastAccText = text;
                round.streamed = true;

                console.log(
                    `[tts:producer] round=${round.msgId.slice(0, 8)} prev=${prev?.length ?? 0} text=${text.length} delta=${delta.length} startsWith=${prev ? text.startsWith(prev) : 'N/A'}`
                );
                console.log(`[tts:producer] delta="${delta.slice(0, 80)}${delta.length > 80 ? '...' : ''}"`);

                round.sendPlaceholder();
                pushTtsDelta(peerId, delta);

                const clean = delta.replace(/\[\[\s*(?:tts|stt)\s*:[^\]]*\]\]/gi, '');
                if (clean) {
                    const sid = round.ensureTextSegment();
                    round.send({ _patch: [{ op: 'append_text', path: 'segments[sid=' + sid + '].text', chunk: clean }] });
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
                round.send({ _patch: [{ op: 'append_text', path: 'reasoning', chunk: delta }] });
            },

            onReasoningEnd: () => {
                round.lastReasoningText = '';
                round.sendPlaceholder();
                round.send({ _patch: [{ op: 'set', path: 'reasoning_complete', value: true }] });
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
                if (payload.phase !== 'end' || !round.lastToolSid) return;
                round.sendPlaceholder();
                round.send({
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
                const phase = payload?.phase;
                const kind = payload?.kind;
                const isToolItem = !kind || kind === 'tool' || kind === 'command' || kind === 'exec' || kind === 'patch' || kind === 'edit';
                if (!isToolItem) return;
                round.sendPlaceholder();
                if (phase === 'start') {
                    if (!round.lastToolSid) return;
                    round.pendingToolSids.push(round.lastToolSid);
                    round.send({ _patch: [{ op: 'merge', path: 'segments[sid=' + round.lastToolSid + ']', value: { phase } }] });
                    return;
                }
                if (phase === 'end' || phase === 'completed' || phase === 'error') {
                    round.markOldestToolPhase(phase);
                }
            },

            onModelSelected: info => {
                round.sendPlaceholder();
                round.send({ model_info: { model: info.model, provider: info.provider, thinkLevel: info.thinkLevel } });
            }
        };

        let voiceErr;
        try {
            console.log(`[agentthere:voice] dispatchReplyFromConfig START round=${round.msgId}`);
            await runtime.channel.reply.dispatchReplyFromConfig({
                ctx: runtime.channel.reply.finalizeInboundContext(msgCtx),
                cfg,
                dispatcher: rpc.dispatcher,
                replyOptions
            });
            console.log(
                `[agentthere:voice] ${Date.now()} dispatchReplyFromConfig COMPLETED round=${round.msgId} streamed=${round.streamed}`
            );
            pushTtsFlush(peerId);
        } catch (err) {
            voiceErr = err;
            console.error(`[agentthere:voice] ${Date.now()} dispatch failed for ${peerId} round=${round.msgId}: ${String(err)}`);
        } finally {
            rpc.markDispatchIdle();
            unsubUsage();
            in_flight_dispatches = Math.max(0, in_flight_dispatches - 1);
            if (in_flight_dispatches === 0) round.final(voiceErr ? { error: String(voiceErr?.message ?? voiceErr) } : undefined);
            armSessionIdleTimer();
        }
    }

    // ── realtime voice session ────────────────────────────────────

    const {
        REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
        createRealtimeVoiceBridgeSession,
        resolveConfiguredRealtimeVoiceProvider,
        resamplePcm
    } = await import('openclaw/plugin-sdk/realtime-voice');

    console.log(`[${accountId}] cfg.realtimeVoice:`, JSON.stringify(cfg?.talk?.realtime ?? 'NOT FOUND'));
    try {
        const realtimeCfg = cfg?.talk?.realtime;
        const resolved = resolveConfiguredRealtimeVoiceProvider({
            cfg,
            configuredProviderId: realtimeCfg?.provider,
            providerConfigs: realtimeCfg?.providers
        });
        console.log(`[${accountId}] resolved provider:`, resolved.provider.id);
        const { provider, providerConfig } = resolved;

        session = createRealtimeVoiceBridgeSession({
            provider,
            cfg,
            providerConfig,
            audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
            audioSink: pcm => res.mediaOut.play(pcm),
            onTranscript(_role, text, isFinal) {
                if (!text) return;

                // ── noise guard ───────────────────────────────────────
                // Must run before display so we can still read transcriptCtx.currentSid.
                if (isFinal && isNoisyTranscript(text)) {
                    console.log(`[agentthere:voice] noise transcript suppressed: "${text}"`);
                    try {
                        const round = currentRound;
                        if (round) {
                            const tc = round._transcriptCtx;
                            if (tc?.currentSid) {
                                // update partial segment: replace "…" with final text, seal it
                                round.send({
                                    _patch: [
                                        { op: 'set', path: `segments[sid=${tc.currentSid}].text`, value: `> **${peerName}**: _${text}_` },
                                        { op: 'merge', path: `segments[sid=${tc.currentSid}]`, value: { complete: true } }
                                    ]
                                });
                                tc.currentSid = null;
                                tc.nextIdx++;
                            }
                            // close loading visually; round stays alive (not finalized) for next speech
                            round.closeLoading();
                        }
                    } catch {
                        /* ignore */
                    }
                    return;
                }

                try {
                    if (!currentRound || currentRound._finalized) {
                        currentRound = res.newRound();
                        console.log(`[agentthere:voice] ${Date.now()} newRound peerId=${peerId} round=${currentRound.msgId}`);
                    }
                    const round = currentRound;

                    let transcriptCtx = round._transcriptCtx;
                    if (!transcriptCtx) {
                        transcriptCtx = { currentSid: null, nextIdx: 0 };
                        round._transcriptCtx = transcriptCtx;
                    }

                    const quote = `> **${peerName}**: _${text}${isFinal ? '' : '…'}_`;

                    if (isFinal) {
                        if (transcriptCtx.currentSid) {
                            round.send({
                                _patch: [
                                    { op: 'set', path: `segments[sid=${transcriptCtx.currentSid}].text`, value: quote },
                                    { op: 'merge', path: `segments[sid=${transcriptCtx.currentSid}]`, value: { complete: true } }
                                ]
                            });
                            transcriptCtx.currentSid = null;
                            transcriptCtx.nextIdx++;
                        } else {
                            const sid = `t${transcriptCtx.nextIdx++}`;
                            round.send({
                                _patch: [{ op: 'push', path: 'segments', value: { sid, kind: 'text', text: quote, complete: true } }]
                            });
                        }
                    } else if (!transcriptCtx.currentSid) {
                        const sid = `t${transcriptCtx.nextIdx}`;
                        transcriptCtx.currentSid = sid;
                        if (!round.placeholderSent) {
                            round.placeholderSent = true;
                            round.send({
                                text: quote,
                                from: { name: peerName, uid: peerId, kind: 'voice-transcript' },
                                loading: true,
                                segments: [{ sid, kind: 'text', text: quote }]
                            });
                        } else {
                            round.reopenLoading();
                            round.send({ _patch: [{ op: 'push', path: 'segments', value: { sid, kind: 'text', text: quote } }] });
                        }
                    } else {
                        round.send({ _patch: [{ op: 'set', path: `segments[sid=${transcriptCtx.currentSid}].text`, value: quote }] });
                    }
                } catch (err) {
                    console.log(`[${accountId}] transcript broadcast error: ${String(err)}`);
                }
                if (isFinal) {
                    console.log(`[agentthere:voice] ${Date.now()} transcript final peerId=${peerId} text="${text.slice(0, 60)}"`);
                    // (noise was already handled above with early return)
                    if (in_flight_dispatches > 0) {
                        console.log(
                            `[agentthere:voice] ${Date.now()} steer peerId=${peerId} round=${currentRound?.msgId} inFlight=${in_flight_dispatches}`
                        );
                        dispatchVoiceTranscript(text, currentRound).catch(err => {
                            console.error(`[${accountId}] voice steer error: ${String(err)}`);
                        });
                    } else {
                        const round = currentRound;
                        console.log(
                            `[agentthere:voice] ${Date.now()} dispatch in round peerId=${peerId} round=${round.msgId} loadingClosed=${round._loadingClosed}`
                        );
                        dispatchVoiceTranscript(text, round).catch(err => {
                            console.error(`[${accountId}] voice dispatch error: ${String(err)}`);
                        });
                    }
                }
            },
            onError(err) {
                console.error(`[${accountId}] voice bridge error for ${peerId}: ${err.message}`);
            },
            onClose(_reason) {
                console.log(`[${accountId}] ${Date.now()} voice bridge closed for ${peerId}`);
            }
        });
        await session.connect();
        console.log(`[${accountId}] ${Date.now()} voice bridge started for ${peerId} (provider=${provider.id})`);
    } catch (err) {
        console.error(`[${accountId}] failed to start voice session for ${peerId}: ${String(err)}`);
        // Graceful fallback: notify the user before draining audio
        const errMsg = err?.message ?? String(err);
        res.sendNote(`⚠️ Voice is not available (${errMsg}).`);
        for await (const _ of streamHandle) {
            /* drain */
        }
        return;
    }

    // ── TTS consumer ──────────────────────────────────────────────

    ensureTtsConsumer(peerId, {
        cfg,
        accountId,
        session,
        onError(msg) {
            res.sendNote(`⚠️ ${msg}`);
        },
        onPcm(pcm) {
            return res.mediaOut.play(pcm);
        },
        onStop() {
            res.mediaOut.stop();
        },
        onResume() {
            res.mediaOut.resume();
        },
        onSilence(ms) {
            session?.updateVad?.({ silenceDurationMs: ms });
            postVoiceHoldMs = ms + 1000;
        },
        onBusyChange(delta) {
            ttsBusy = Math.max(0, ttsBusy + delta);
            if (ttsBusy === 0) armSessionIdleTimer();
        },
        onCancelIdle() {
            cancelIdleTimer();
        }
    });
    console.log(`[${accountId}] ${Date.now()} voice session ready for ${peerId}`);

    // ── inbound stream loop ───────────────────────────────────────

    const decodeOpus = await _getDecodeOpus();
    cancelIdleTimer();

    try {
        for await (const audioData of streamHandle) {
            // PT check — skip non-Opus packets.
            if (audioData.length >= 2) {
                const pt = audioData[1] & 0x7f;
                if (pt !== 111) continue;
            }

            // Decode Opus → PCM48 → resample to 24kHz.
            let pcm;
            try {
                const pcm48 = await decodeOpus(audioData);
                if (!pcm48) continue;
                pcm = resamplePcm(pcm48, 48000, 24000);
            } catch (err) {
                console.log(`[${accountId}] audio decode error for ${peerId}: ${String(err)}`);
                continue;
            }

            // VAD — skip silent frames after the post-voice hold period.
            const now = Date.now();
            const isVoice = !isSilentPcm16(pcm);
            if (isVoice) {
                _lastVoiceTs.set(peerId, now);
                cancelIdleTimer();
            } else {
                const last = _lastVoiceTs.get(peerId);
                if (!last || now - last > postVoiceHoldMs) {
                    if (last) _lastVoiceTs.delete(peerId);
                    continue;
                }
            }

            // Send PCM to the voice bridge.
            try {
                session?.sendAudio(pcm);
            } catch {
                /* ignore */
            }
        }
    } finally {
        console.log(`[agentthere-audio] ${Date.now()} stream close peerId=${peerId} (peer disconnect — session persisted)`);
        for (const round of res._rounds) {
            if (!round._finalized) {
                console.log(`[agentthere:voice] ${Date.now()} final round=${round.msgId} (stream cleanup)`);
                round.final();
            }
        }
        _lastVoiceTs.delete(peerId);
        closeTtsQueue(peerId);
        armSessionIdleTimer();
    }
}
