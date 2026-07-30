/**
 * Group-level Agent output stream.
 *
 * Pi emits one Session-level event stream. This object projects that stream
 * onto the current AgentThere Round and the group's TTS outputs.
 */
import { OutboundResponse } from "./rtc/outbound-response.js";
import { getGroup } from "./rtc/index.js";
import { OutboundTts } from "./rtc/outbound-tts/index.js";

export class GroupOutputStream {
    constructor({ groupId, agentFrom = null, ttsConfig = null }) {
        this.groupId = groupId;
        this._agentFrom = agentFrom;
        this._sttOpen = false;
        this.tts = new OutboundTts({
            groupId,
            getConfig: () => typeof ttsConfig === "function" ? ttsConfig() : ttsConfig,
        });
        this.response = new OutboundResponse({
            groupId,
            agentFrom: () => this.getAgentFrom(),
        });
    }

    getAgentFrom() {
        return typeof this._agentFrom === "function" ? this._agentFrom() : this._agentFrom;
    }

    ensureRound() {
        if (!this.response.current || this.response.current._finalized) {
            this.response.newRound();
        }
        return this.response.current;
    }

    send(payload) {
        const round = this.ensureRound();
        return round.send(payload);
    }

    closeRound() {
        const round = this.response.current;
        if (!round || round._finalized) return;
        round.final();
    }

    onAgentEnd() {
        if (!this._sttOpen) this.closeRound();
    }

    setSttOpen(open) {
        this._sttOpen = Boolean(open);
    }

    transcript(text, isFinal, peerName) {
        if (!text) return;
        const trimmed = String(text).trim();
        if (!trimmed) return;

        const round = this.ensureRound();
        let tc = round._transcriptCtx;
        if (!tc) {
            tc = { currentSid: null, nextIdx: 0 };
            round._transcriptCtx = tc;
        }
        const quote = `> **${peerName || "User"}**: _${trimmed}${isFinal ? "" : "…"}_`;

        if (isFinal) {
            this._sttOpen = false;
            if (tc.currentSid) {
                const segment = round.segments.find((item) => item.sid === tc.currentSid);
                if (segment) {
                    segment.text = quote;
                    segment.complete = true;
                }
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
                const segment = { sid, kind: "text", text: quote, complete: true };
                round.segments.push(segment);
                if (!round.placeholderSent) {
                    round.placeholderSent = true;
                    round.send({
                        text: quote,
                        from: { ...this.getAgentFrom(), kind: "voice-transcript" },
                        loading: true,
                        segments: [segment],
                    });
                }
                else {
                    round.send({ _patch: [{ op: "push", path: "segments", value: segment }] });
                }
            }
            return;
        }

        this._sttOpen = true;
        if (!tc.currentSid) {
            const sid = `t${tc.nextIdx}`;
            const segment = { sid, kind: "text", text: quote, complete: false };
            round.segments.push(segment);
            tc.currentSid = sid;
            if (!round.placeholderSent) {
                round.placeholderSent = true;
                round.send({
                    text: quote,
                    from: { ...this.getAgentFrom(), kind: "voice-transcript" },
                    loading: true,
                    segments: [segment],
                });
            }
            else {
                round.reopenLoading();
                round.send({ _patch: [{ op: "push", path: "segments", value: segment }] });
            }
        }
        else {
            const segment = round.segments.find((item) => item.sid === tc.currentSid);
            if (segment) segment.text = quote;
            round.send({ _patch: [{ op: "set", path: `segments[sid=${tc.currentSid}].text`, value: quote }] });
        }
    }

    emitTtsDelta(text) {
        this.tts.push(text);
    }

    flushTts() {
        this.tts.flush();
    }

    activateTts() {
        this.tts.activate();
    }

    interruptTts() {
        this.tts.interrupt();
    }

    close() {
        this.tts.close();
    }
}
