/**
 * Outbound response and multi-round lifecycle for AgentThere.
 *
 * A Round owns one visible reply bubble. OutboundResponse keeps the round
 * history and provides the delivery channel used by the RTC peers.
 */

import { MediaOutSender } from "./media-out.js";
import { getGroup } from "./index.js";
import { createMessageId } from "../messaging.js";

let _sidCounter = 0;

class Round {
    constructor({ msgId, delivery, agentFrom }) {
        this.msgId = msgId;
        this._delivery = delivery;
        this.agentFrom = agentFrom;
        this.placeholderSent = false;
        this._presetBubble = false;
        this._finalized = false;
        // reply state (was replyTracker)
        this.segments = [];
        this.modelInfo = null;
        this.reasoningSid = null;
        this.usage = null;
    }

    send(payload) {
        if (!payload) return;
        if (payload && payload.id === this.msgId) {
            let event;
            if (Array.isArray(payload._patch) && payload._patch.length > 0) {
                event = "patch";
            }
            else if (payload.model_info) event = "model";
            else if (payload.usage) event = "usage";
            else if (payload.loading === true) event = "placeholder";
            else if (payload.loading === false) event = "close";
            else event = "other";
            // Patch messages are high-frequency transport details. Logging
            // each one makes normal replies unnecessarily noisy.
            if (event !== "patch") {
                console.log(`[agentthere:round] send round=${this.msgId} evt=${event}`);
            }
        }

        if (!payload.id) payload = { ...payload, id: this.msgId };
        return this._delivery(payload);
    }

    sendPlaceholder() {
        if (this.placeholderSent) return;
        this.placeholderSent = true;
        const from = typeof this.agentFrom === "function" ? this.agentFrom() : this.agentFrom;
        this.send({ id: this.msgId, text: "", from, loading: true, segments: [] });
    }

    /** Close the visual loading indicator while keeping the round reusable. */
    closeLoading(extra) {
        if (this._finalized || !this.placeholderSent) return;
        if (this._presetBubble) {
            if (extra && Object.keys(extra).length > 0) this.send({ id: this.msgId, ...extra });
            return;
        }
        this.send({ id: this.msgId, loading: false, ...(extra ?? {}) });
    }

    reopenLoading() {
        if (this._finalized || !this.placeholderSent) return;
        this.send({ id: this.msgId, loading: true });
    }

    final(extra) {
        if (this._finalized) return;
        this._finalized = true;
        if (!this.placeholderSent) return;
        if (this._presetBubble) {
            if (extra && Object.keys(extra).length > 0) this.send({ id: this.msgId, ...extra });
            return;
        }
        this.send({ id: this.msgId, loading: false, ...(extra ?? {}) });
    }

    // ── reply state lifecycle (was replyTracker) ───────────────────────
    resetReplyState() {
        // Voice transcript segments belong to the Round, not to one Agent
        // response. Keep them when the next assistant turn starts.
        this.segments = this.segments.filter((segment) =>
            segment.kind === "text" && String(segment.sid).startsWith("t"),
        );
        this.modelInfo = null;
        this.reasoningSid = null;
        this.usage = null;
        if (this.segments.length === 0) this.placeholderSent = false;
    }

    nextSid() {
        _sidCounter += 1;
        return `s${_sidCounter}`;
    }
}

export class OutboundResponse {
    constructor(opts) {
        this._send = opts.send ?? null;
        this._groupId = opts.groupId ?? null;
        this._peerId = opts.peerId ?? null;
        this.agentFrom = opts.agentFrom ?? null;
        this.mediaOut = opts.peerId ? new MediaOutSender(opts.peerId, opts.groupId) : null;
        this._rounds = [];
        this.current = null;
        const round = null;
        if (opts.presetBubble && round) {
            round._presetBubble = true;
            round.placeholderSent = true;
        }
    }

    _rawSend(payload) {
        if (this._send) return this._send(payload);
        const group = getGroup(this._groupId);
        return group ? group.send(JSON.stringify(payload)) : 0;
    }

    newRound(msgId) {
        const round = new Round({
            msgId: msgId ?? createMessageId(),
            delivery: this._rawSend.bind(this),
            agentFrom: this.agentFrom,
        });
        this._rounds.push(round);
        this.current = round;
        console.log(`[agentthere:round] ${Date.now()} newRound msgId=${round.msgId} totalRounds=${this._rounds.length}`);
        return round;
    }

    getRound(msgId) {
        return this._rounds.find((round) => round.msgId === msgId);
    }

    getRounds() {
        return this._rounds;
    }

    send(payload) {
        return this.current?.send(payload);
    }

    sendPlaceholder() {
        return this.current?.sendPlaceholder();
    }

    closeLoading(extra) {
        return this.current?.closeLoading(extra);
    }

    final(extra) {
        return this.current?.final(extra);
    }
}
