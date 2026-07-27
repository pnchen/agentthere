/**
 * Outbound response and multi-round lifecycle for AgentThere.
 *
 * A Round owns one visible reply bubble. OutboundResponse keeps the round
 * history and provides the delivery channel used by the RTC peers.
 */

import { getPeers, getGroupPeers } from "../../rtc/index.js";
import { createMessageId } from "../messaging.js";
import { MediaOutSender } from "./media-out.js";

class Round {
    constructor({ msgId, delivery, agentFrom }) {
        this.msgId = msgId;
        this._delivery = delivery;
        this.agentFrom = agentFrom;
        this.placeholderSent = false;
        this._presetBubble = false;
        this._finalized = false;
    }

    send(payload) {
        if (!payload) return;
        if (payload && payload.id === this.msgId) {
            let event;
            if (Array.isArray(payload._patch) && payload._patch.length > 0) {
                const first = payload._patch[0];
                const tail = String(first.path || "").split(".").pop() || "?";
                event = `patch:${first.op}:${tail}`;
            }
            else if (payload.model_info) event = "model";
            else if (payload.usage) event = "usage";
            else if (payload.loading === true) event = "placeholder";
            else if (payload.loading === false) event = "close";
            else event = "other";
            if (!event.startsWith("patch:append_text")) {
                console.log(`[agentthere:round] send round=${this.msgId} evt=${event}`);
            }
        }

        if (!payload.id) payload = { ...payload, id: this.msgId };
        return this._delivery(payload);
    }

    sendPlaceholder() {
        if (this.placeholderSent) return;
        this.placeholderSent = true;
        this.send({ id: this.msgId, text: "", from: this.agentFrom, loading: true, segments: [] });
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
}

export class OutboundResponse {
    constructor(opts) {
        this._mode = opts.mode;
        this._groupId = opts.groupId ?? null;
        this._peerId = opts.peerId ?? null;
        this._send = opts.send ?? null;
        this._getPeerIds = opts.getPeerIds ?? null;
        this.agentFrom = opts.agentFrom ?? null;
        this.mediaOut = opts.peerId ? new MediaOutSender(opts.peerId, opts.groupId) : null;
        this._rounds = [];
        this.current = null;
        const round = this.newRound(opts.msgId);
        if (opts.presetBubble) {
            round._presetBubble = true;
            round.placeholderSent = true;
        }
    }

    _getTargets() {
        if (this._mode === "group" && this._groupId) return getGroupPeers(this._groupId);
        if (this._peerId) {
            const p = this._groupId
                ? getPeers()?.get(`${this._groupId}.${this._peerId}`)
                : [...(getPeers()?.values() ?? [])].find((peer) => peer.peerId === this._peerId);
            return p ? [p] : [];
        }
        return [];
    }

    _rawSend(payload) {
        if (this._send) return this._send(payload);
        const data = JSON.stringify(payload);
        const peerIds = this._getPeerIds?.();
        const targets = peerIds
            ? peerIds.map((peerId) => this._groupId
                ? getPeers()?.get(`${this._groupId}.${peerId}`)
                : [...(getPeers()?.values() ?? [])].find((peer) => peer.peerId === peerId)).filter(Boolean)
            : this._getTargets();
        let sent = 0;
        for (const peer of targets) {
            if (peer.send(data)) sent++;
        }
        if (targets.length === 0) {
            console.warn(`[agentthere:send] zero targets — mode=${this._mode} groupId=${this._groupId} peerId=${this._peerId}`);
        }
        return sent;
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
