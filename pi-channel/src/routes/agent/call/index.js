import express from "express";
import { takeCallStream } from "../../../rtc/call-streams.js";
import { historyContext } from "../middleware/history-context.js";
import { authGate } from "../middleware/auth-gate/index.js";
import { decodeOpus } from "./opus-codec.js";
import { resamplePcm } from "./audio-decode.js";
import { createStt } from "./stt.js";

function isNoisyTranscript(text) {
    if (!text || text.length > 10) return false;
    const core = text.replace(/[^嗯啊哦哈呃额唔呀哎哟喂\u4e00-\u9fff]/g, "");
    if (core.length < 2) return true;
    return core.length <= 3 && /^[嗯啊哦哈呃额唔呀哎哟喂]{1,3}$/.test(core);
}

const router = express.Router();

router.use((req, res, next) => {
    const streamId = req.body?.streamId;
    if (!streamId) {
        return res.status(400).json({ accepted: false, error: "streamId is required" });
    }
    req.$message = { type: "call", streamId: String(streamId) };
    req.$mentioned = true;
    next();
});

router.use(historyContext);
router.use(authGate);

router.post("/", async (req, res, next) => {
    try {
        const streamHandle = takeCallStream(req.$message.streamId);
        if (!streamHandle) {
            return res.status(404).json({ accepted: false, error: "call stream not found" });
        }

        req.$message = { type: "call", streamHandle };

        const session = req.$agent_session.session;
        const output = req.$agent_session.output;
        const peer = req.$peer;
        const peerId = peer.peerId;
        let ttsInterruptedForSpeech = false;

        const interruptTtsForSpeech = (source) => {
            if (ttsInterruptedForSpeech) return;
            ttsInterruptedForSpeech = true;
            console.log(`[agentthere:voice] interrupt Group TTS on speech ${source} peerId=${peerId}`);
            output.interruptTts();
        };

        const dispatchVoiceTranscript = (text) => {
            const trimmed = text?.trim();
            if (!trimmed || isNoisyTranscript(trimmed)) return false;
            const promptText = req.$getCombinedBody({ type: "text", text: trimmed });
            try {
                output.interruptTts();
                if (session.isStreaming) session.steer(promptText);
                else session.prompt(promptText);
                return true;
            }
            catch (error) {
                console.error(`[agentthere:voice] prompt/steer failed: ${String(error)}`);
                return false;
            }
        };

        const stt = createStt({
            config: req.$agent_session.getSttConfig?.(),
            onSpeechStarted: () => {
                ttsInterruptedForSpeech = false;
                output.activateTts();
                interruptTtsForSpeech("speech_started");
            },
            onTranscript: (text, isFinal) => {
                if (!isFinal) interruptTtsForSpeech("partial");
                output.transcript(text, isFinal, peer.peerName);
                if (isFinal) {
                    if (!dispatchVoiceTranscript(text)) output.closeRound();
                    ttsInterruptedForSpeech = false;
                }
            },
            onError: (error) => console.error(`[agentthere:voice] stt error for ${peerId}: ${String(error)}`),
        });

        (async () => {
            console.log(`[agentthere-audio] stream open peerId=${peerId} groupId=${req.$group.groupId}`);
            try {
                for await (const audioData of streamHandle) {
                    if (audioData.length >= 2 && (audioData[1] & 0x7f) !== 111) continue;
                    let pcm;
                    try {
                        const pcm48 = await decodeOpus(audioData);
                        if (!pcm48) continue;
                        pcm = resamplePcm(pcm48, 48000, 16000);
                    }
                    catch (error) {
                        console.log(`[agentthere:voice] audio decode error for ${peerId}: ${String(error)}`);
                        continue;
                    }
                    stt.feedPcm(pcm, 16000);
                }
            }
            finally {
                console.log(`[agentthere-audio] stream close peerId=${peerId}`);
                stt.close();
                output.setSttOpen(false);
                if (!session.isStreaming) output.closeRound();
            }
        })().catch((error) => {
            console.error(`[agentthere-audio] call failed: ${String(error)}`);
        });

        return res.status(202).json({ accepted: true });
    }
    catch (error) {
        return next(error);
    }
});

export default router;
