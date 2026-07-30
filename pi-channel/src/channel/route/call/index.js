/**
 * Voice call route handler.
 *
 * Mirrors openclaw-plugin/channel/src/channel/route/call/index.js
 * but for Pi SDK AgentSession.
 *
 * Opus RTP → decodeOpus → PCM → STT → (broadcast transcript to client) → direct agent reply
 *
 * The agent reply is routed directly into the current voice round instead of
 * going through the text-message SdkBridge path (which would create a separate bubble).
 */

import { decodeOpus } from "./opus-codec.js";
import { resamplePcm, isSilentPcm16 } from "./audio-decode.js";
import { createStt } from "./stt.js";
import {
    ensureTtsConsumer,
    closeTtsQueue,
    cancelTtsQueue,
    pushTtsDelta,
    pushTtsFlush,
} from "./tts-queue.js";
import { ReplyRenderer } from "../../reply-renderer.js";

const VOICE_PEAK_THRESHOLD = 800;
const VOICE_HOLD_MS = 5_000;

function isNoisyTranscript(text) {
    const core = text.replace(/[\s\p{P}\p{S}]/gu, "");
    if (core.length < 2) return true;
    if (core.length <= 3 && /^[嗯啊哦哈呃额唔呀哎哟喂]{1,3}$/.test(core)) return true;
    return false;
}

export async function callHandler(ctx) {
    const { session, groupId, peer, streamHandle, sttConfig, ttsConfig, res, bridge, getCombinedBody } = ctx;
    const peerId = peer.peerId;

    console.log(`[agentthere-audio] stream open peerId=${peerId} groupId=${groupId}`);

    let currentRound = null;
    let hasOpenTranscript = false;
    let replyPending = false;
    let ttsInterruptedForSpeech = false;

    function interruptTtsForSpeech(source) {
        if (ttsInterruptedForSpeech) return;
        ttsInterruptedForSpeech = true;
        console.log(`[agentthere:voice] interrupt TTS on speech ${source} peerId=${peerId}`);
        cancelTtsQueue(peerId, () => res.mediaOut.stop());
    }

    const replyRenderer = new ReplyRenderer({
        agentFrom: () => ({ ...res.agentFrom, agent: true }),
        replyId: () => currentRound?.msgId,
        send: (message) => currentRound?.send(message),
        tts: {
            onDelta: (text) => pushTtsDelta(peerId, text),
            onFlush: () => pushTtsFlush(peerId),
        },
        getThinkLevel: () => session.thinkingLevel,
        getContextUsage: () => session.getContextUsage?.(),
    });

    function ensureRound() {
        if (!currentRound || currentRound._finalized) {
            const reusable = res.current && !res.current._finalized ? res.current : null;
            currentRound = reusable || res.newRound();
            console.log(`[agentthere:voice] newRound peerId=${peerId} round=${currentRound.msgId}`);
        }
        return currentRound;
    }

    function buildTranscriptQuote(text, isFinal) {
        return `> **${peer.peerName}**: _${text}${isFinal ? "" : "…"}_`;
    }

    function broadcastTranscript(text, isFinal) {
        if (!text) return;

        if (isFinal && isNoisyTranscript(text.trim())) {
            console.log(`[agentthere:voice] noise transcript suppressed: "${text}"`);
            const round = currentRound;
            if (round?._transcriptCtx?.currentSid) {
                const tc = round._transcriptCtx;
                round.send({
                    _patch: [
                        { op: "set", path: `segments[sid=${tc.currentSid}].text`, value: buildTranscriptQuote(text, true) },
                        { op: "merge", path: `segments[sid=${tc.currentSid}]`, value: { complete: true } },
                    ],
                });
                tc.currentSid = null;
                tc.nextIdx++;
            }
            round?.closeLoading();
            return;
        }

        const round = ensureRound();
        let tc = round._transcriptCtx;
        if (!tc) {
            tc = { currentSid: null, nextIdx: 0 };
            round._transcriptCtx = tc;
        }

        const quote = buildTranscriptQuote(text, isFinal);

        if (isFinal) {
            if (tc.currentSid) {
                round.send({
                    _patch: [
                        { op: "set", path: `segments[sid=${tc.currentSid}].text`, value: quote },
                        { op: "merge", path: `segments[sid=${tc.currentSid}]`, value: { complete: true } },
                    ],
                });
                tc.currentSid = null;
                tc.nextIdx++;
            }
            else {
                const sid = `t${tc.nextIdx++}`;
                round.send({
                    _patch: [{ op: "push", path: "segments", value: { sid, kind: "text", text: quote, complete: true } }],
                });
            }
        }
        else {
            if (!tc.currentSid) {
                const sid = `t${tc.nextIdx}`;
                tc.currentSid = sid;
                if (!round.placeholderSent) {
                    round.placeholderSent = true;
                    round.send({
                        text: quote,
                        from: { name: peer.peerName, uid: peerId, kind: "voice-transcript" },
                        loading: true,
                        segments: [{ sid, kind: "text", text: quote }],
                    });
                }
                else {
                    round.reopenLoading();
                    round.send({ _patch: [{ op: "push", path: "segments", value: { sid, kind: "text", text: quote } }] });
                }
            }
            else {
                round.send({ _patch: [{ op: "set", path: `segments[sid=${tc.currentSid}].text`, value: quote }] });
            }
        }
    }

    function dispatchVoiceTranscript(text) {
        const trimmed = text?.trim();
        if (!trimmed || isNoisyTranscript(trimmed)) return false;

        const round = ensureRound();
        const promptText = getCombinedBody?.({ type: "text", text: trimmed }) ?? `[${peer.peerName}]: ${trimmed}`;
        try {
            cancelTtsQueue(peerId, () => res.mediaOut.stop());
            bridge?.setPeerContext(groupId, peer);
            bridge?.setVoiceReplyRound(round, handleVoiceSessionEvent);
            // session.prompt()/steer() starts asynchronously. Mark the reply as
            // pending before calling it so STT final cannot close the round first.
            replyPending = true;
            if (session.isStreaming) {
                console.log(`[agentthere:voice] steer peerId=${peerId} round=${round.msgId} text="${trimmed.slice(0, 60)}"`);
                session.steer(promptText);
            }
            else {
                console.log(`[agentthere:voice] prompt peerId=${peerId} round=${round.msgId} text="${trimmed.slice(0, 60)}"`);
                session.prompt(promptText);
            }
            return true;
        }
        catch (err) {
            replyPending = false;
            bridge?.clearVoiceReplyRound(round);
            console.error(`[agentthere:voice] prompt/steer failed: ${String(err)}`);
            return false;
        }
    }

    function closeVoiceRound() {
        const round = currentRound;
        bridge?.clearVoiceReplyRound(round);
        if (round && !round._finalized) {
            round.final();
            console.log(`[agentthere:voice] finalizeRound peerId=${peerId} round=${round.msgId}`);
        }
    }

    function finalizeIfIdle() {
        if (hasOpenTranscript || replyPending || session.isStreaming) return;
        closeVoiceRound();
    }

    function handleVoiceSessionEvent(event) {
        replyRenderer.handle(event);
        if (event.type === "agent_end") {
            replyPending = false;
            // The round may stay open for a partial STT transcript, but the
            // completed agent reply no longer owns future session events.
            bridge?.clearVoiceReplyRound(currentRound);
            if (!hasOpenTranscript) {
                closeVoiceRound();
                bridge?.clearPeerContext(peerId);
            }
        }
    }

    ensureTtsConsumer(peerId, {
        ttsConfig,
        onPcm: (pcm) => res.mediaOut.play(pcm),
        onStop: () => res.mediaOut.stop(),
        onResume: () => res.mediaOut.resume(),
        onError: (error) => console.error(`[agentthere:voice] ${error}`),
    });

    const stt = createStt({
        config: sttConfig,
        onSpeechStarted: () => {
            ttsInterruptedForSpeech = false;
            interruptTtsForSpeech("speech_started");
        },
        onTranscript: (text, isFinal) => {
            if (!isFinal) {
                hasOpenTranscript = true;
                interruptTtsForSpeech("partial");
            }
            broadcastTranscript(text, isFinal);
            if (isFinal) {
                hasOpenTranscript = false;
                const dispatched = dispatchVoiceTranscript(text);
                // A real transcript has handed ownership to the pending agent
                // reply. Only finalize here when no reply was dispatched (for
                // example, empty/noisy speech).
                if (!dispatched) finalizeIfIdle();
                ttsInterruptedForSpeech = false;
            }
        },
        onError: (err) => {
            console.error(`[agentthere:voice] stt error for ${peerId}: ${String(err)}`);
        },
    });

    try {
        for await (const audioData of streamHandle) {
            if (audioData.length >= 2) {
                const pt = audioData[1] & 0x7f;
                if (pt !== 111) continue;
            }

            let pcm;
            try {
                const pcm48 = await decodeOpus(audioData);
                if (!pcm48) continue;
                pcm = resamplePcm(pcm48, 48000, 16000);
            }
            catch (err) {
                console.log(`[agentthere:voice] audio decode error for ${peerId}: ${String(err)}`);
                continue;
            }

            stt.feedPcm(pcm, 16000);
        }
    }
    finally {
        console.log(`[agentthere-audio] stream close peerId=${peerId}`);
        stt.close();
        closeTtsQueue(peerId);
        for (const round of res.getRounds()) {
            if (!round._finalized) {
                console.log(`[agentthere:voice] finalize round=${round.msgId} (stream cleanup)`);
                round.final();
            }
        }
        bridge?.clearVoiceReplyRound(currentRound);
        bridge?.clearPeerContext(peerId);
    }
}
