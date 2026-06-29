/**
 * Outbound response — delivery + multi-round reply state machine.
 *
 * `Round` holds per-bubble state (msgId, segments, accumulator, lifecycle).
 * `OutboundResponse` coordinates delivery and round history. All rounds
 * share the same delivery channel; each round is independently modifiable.
 *
 * Construction:
 *   // standard (uses listPeers for target resolution):
 *   const res = new OutboundResponse({ mode: 'group', groupId, ... });
 *
 *   // custom send (e.g. voice broadcast):
 *   const res = new OutboundResponse({ send: obj => broadcast(obj), ... });
 *
 * Multi-round voice call:
 *   const round1 = res.newRound();   // Round 1 bubble
 *   const round2 = res.newRound();   // Round 2 bubble — round1 still alive
 *   round1.closeLoading();           // independent close
 *
 * Text message flow:
 *   const round = res.current;  // already initialized
 *   round.msgId = msgId; round.agentFrom = agentFrom; ...
 */

import { getPeers, getGroupPeers } from '../rtc/index.js';
import { createMessageId } from '../messaging.js';
import { sendMedia as _sendMedia } from '../file-send.js';
import { MediaOutSender } from './media-out.js';

const MEDIA_KEY_RE = /---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^./\\]+)?$/i;

// ── Round — per-bubble state ────────────────────────────────────────────

class Round {
    constructor({ msgId, delivery, agentFrom }) {
        this.msgId = msgId;
        this._delivery = delivery;
        this.agentFrom = agentFrom;

        // ── segment state machine ─────────────────────────────
        this._sidCounter = 0;
        this._sidPrefix = 's';
        this.currentTextSid = null;
        this.lastToolSid = null;
        this.pendingToolSids = [];

        // ── streaming accumulator ─────────────────────────────
        this.lastAccText = '';
        this.ttsOffset = 0;
        this.streamed = false;

        // ── reasoning ─────────────────────────────────────────
        this.lastReasoningText = '';

        // ── media ─────────────────────────────────────────────
        this.mediaTokenSeen = false;
        this.sentMediaKeys = new Set();

        // ── lifecycle ─────────────────────────────────────────
        this.placeholderSent = false;
        this._presetBubble = false;
        this._finalized = false;
    }

    // ── delivery ──────────────────────────────────────────────

    send(payload) {
        console.log(`[agentthere:round] send msgId=${this.msgId} payload=`, payload);
        // ── debug trace ───────────────────────────────────
        if (payload && payload.id === this.msgId) {
            let evt;
            if (Array.isArray(payload._patch) && payload._patch.length > 0) {
                const first = payload._patch[0];
                const tail =
                    String(first.path || '')
                        .split('.')
                        .pop() || '?';
                evt = 'patch:' + first.op + ':' + tail;
            } else if (payload.model_info) evt = 'model';
            else if (payload.usage) evt = 'usage';
            else if (payload.loading === true) evt = 'placeholder';
            else if (payload.loading === false) evt = 'close';
            else evt = 'other';
            if (!evt.startsWith('patch:append_text')) {
                console.log(`[agentthere:bc] round=${this.msgId} evt=${evt}`);
            }
        }

        if (!payload.id) payload = { ...payload, id: this.msgId };
        return this._delivery(payload);
    }

    sendError(message) {
        return this.send({ type: 'system', text: String(message) });
    }

    sendText(text, opts = {}) {
        const { createMessageId, buildOutboundTextMessage, agentProfile } = opts;
        if (!createMessageId || !buildOutboundTextMessage || !agentProfile) {
            return this.send({ text, from: { name: 'agent', agent: true } });
        }
        const payload = buildOutboundTextMessage({ text, agentProfile });
        return this.send(payload);
    }

    /** Send a system note as a standalone bubble. */
    sendNote(text) {
        return this.send({
            id: createMessageId(),
            text,
            from: this.agentFrom,
            system: true
        });
    }

    /** Send a media file to targets resolved from this response. */
    async sendMedia({ rawUrl, kind, groupId, peerId }) {
        return _sendMedia({
            rawUrl,
            groupId: groupId ?? this._groupId,
            peerId: peerId ?? this._peerId,
            agentProfile: this.agentFrom,
            kind
        });
    }

    /** Send usage statistics derived from a diagnostic event. */
    sendUsage(evt) {
        const input = evt.usage?.input ?? 0;
        const output = evt.usage?.output ?? 0;
        const cacheRead = evt.usage?.cacheRead ?? 0;
        const cacheWrite = evt.usage?.cacheWrite ?? 0;
        const total = evt.usage?.total ?? input + output;
        const limit = evt.context?.limit ?? 0;
        const pct = limit > 0 ? Math.round((total / limit) * 100) : null;
        const fmt = n => (n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(n));

        const totalInput = input + cacheRead + cacheWrite;
        const hitRate = totalInput > 0 ? Math.round((cacheRead / totalInput) * 100) : 0;

        this.send({
            usage: {
                model: evt.model,
                provider: evt.provider,
                input,
                output,
                cache_read: cacheRead,
                cache_write: cacheWrite,
                total,
                context_limit: limit,
                context_used: total,
                context_pct: pct,
                duration_ms: evt.durationMs,
                cost: evt.costUsd,
                summary: [
                    `${fmt(total)} / ${fmt(limit)} tokens`,
                    pct != null ? `${pct}%` : null,
                    `↑${fmt(input)} ↓${fmt(output)}`,
                    cacheRead > 0 ? `cache ${hitRate}%` : null,
                    evt.durationMs ? `${(evt.durationMs / 1000).toFixed(1)}s` : null
                ]
                    .filter(Boolean)
                    .join(' · ')
            }
        });
    }

    // ── segment helpers ───────────────────────────────────────

    nextSid() {
        return this._sidPrefix + ++this._sidCounter;
    }

    _patch(ops) {
        this.send({ id: this.msgId, _patch: ops });
    }

    ensureTextSegment() {
        if (!this.currentTextSid) {
            const sid = this.nextSid();
            this.currentTextSid = sid;
            this._patch([{ op: 'push', path: 'segments', value: { sid, kind: 'text', text: '' } }]);
        }
        return this.currentTextSid;
    }

    sealTextSegment() {
        if (this.currentTextSid) {
            this._patch([{ op: 'merge', path: 'segments[sid=' + this.currentTextSid + ']', value: { complete: true } }]);
            this.currentTextSid = null;
        }
    }

    markOldestToolPhase(phase) {
        if (this.pendingToolSids.length === 0) return;
        const sid = this.pendingToolSids.shift();
        this._patch([{ op: 'merge', path: 'segments[sid=' + sid + ']', value: { phase } }]);
    }

    // ── placeholder ───────────────────────────────────────────

    sendPlaceholder() {
        if (this.placeholderSent) return;
        this.placeholderSent = true;
        this.send({ id: this.msgId, text: '', from: this.agentFrom, loading: true, segments: [] });
    }

    // ── lifecycle ─────────────────────────────────────────────

    /** Close the visual loading indicator only; round remains reusable. */
    closeLoading(extra) {
        if (this._finalized) return;
        if (!this.placeholderSent) return;
        if (this._presetBubble) {
            if (extra && Object.keys(extra).length > 0) this.send({ id: this.msgId, ...extra });
            return;
        }
        this.sealTextSegment();
        this.send({ id: this.msgId, loading: false, ...(extra ?? {}) });
    }

    /** Re-open the loading indicator after a closeLoading() (e.g. new speech after noise). */
    reopenLoading() {
        if (this._finalized || !this.placeholderSent) return;
        this.send({ id: this.msgId, loading: true });
    }

    /** Permanently close the round; no more content will be sent. */
    final(extra) {
        if (this._finalized) return;
        this._finalized = true;
        if (!this.placeholderSent) return;
        if (this._presetBubble) {
            if (extra && Object.keys(extra).length > 0) this.send({ id: this.msgId, ...extra });
            return;
        }
        this.sealTextSegment();
        this.send({ id: this.msgId, loading: false, ...(extra ?? {}) });
    }

    // ── media dedup ───────────────────────────────────────────

    /** Strip per-message UUID suffix so same file across replies is deduped. */
    stageMediaKey(rawUrl) {
        return String(rawUrl).replace(MEDIA_KEY_RE, '$1');
    }
}

// ── OutboundResponse — session coordinator ──────────────────────────────

export class OutboundResponse {
    constructor(opts) {
        // ── delivery config (shared across all rounds) ──────
        this._mode = opts.mode;
        this._groupId = opts.groupId ?? null;
        this._peerId = opts.peerId ?? null;
        this._send = opts.send ?? null;
        this._getPeerIds = opts.getPeerIds ?? null;
        this.agentFrom = opts.agentFrom ?? null;
        // ── media out ────────────────────────────────────
        this.mediaOut = opts.peerId ? new MediaOutSender(opts.peerId, opts.groupId) : null;
        // ── rounds history ──────────────────────────────────
        this._rounds = [];
        this.current = null;
        const round = this.newRound(opts.msgId);
        if (opts.presetBubble) {
            round._presetBubble = true;
            round.placeholderSent = true;
            round._sidPrefix = `d${Date.now().toString(36).slice(-4)}`;
        }
    }

    // ── delivery ──────────────────────────────────────────────

    _getTargetPeerIds() {
        if (this._mode === 'group' && this._groupId) {
            return getGroupPeers(this._groupId).map(s => s.peerId);
        }
        if (this._peerId) return [this._peerId];
        return [];
    }

    _getTargets() {
        if (this._mode === 'group' && this._groupId) {
            return getGroupPeers(this._groupId);
        }
        if (this._peerId) {
            const p = this._groupId
                ? getPeers()?.get(`${this._groupId}.${this._peerId}`)
                : [...(getPeers()?.values() ?? [])].find(p => p.peerId === this._peerId);
            return p ? [p] : [];
        }
        return [];
    }

    _rawSend(payload) {
        if (this._send) return this._send(payload);
        const data = JSON.stringify(payload);
        if (this._getPeerIds) {
            const pids = this._getPeerIds();
            let sent = 0;
            for (const pid of pids) {
                const p = this._groupId
                    ? getPeers()?.get(`${this._groupId}.${pid}`)
                    : [...(getPeers()?.values() ?? [])].find(p => p.peerId === pid);
                if (p) {
                    const ok = p.send(data);
                    if (ok) sent++;
                }
            }
            if (sent === 0) {
                console.warn(`[agentthere:send] NO target reached — groupId=${this._groupId} peerIds=[${pids.join(',')}] peersTotal=${getPeers()?.size ?? 0}`);
            }
            return sent;
        }
        const targets = this._getTargets();
        let sent = 0;
        for (const t of targets) {
            const ok = t.send(data);
            if (ok) sent++;
        }
        if (targets.length === 0) {
            console.warn(`[agentthere:send] zero targets — mode=${this._mode} groupId=${this._groupId} peerId=${this._peerId} peersTotal=${getPeers()?.size ?? 0}`);
        } else if (sent === 0) {
            console.warn(`[agentthere:send] all sends failed — targets=${targets.length} groupId=${this._groupId}`);
        }
        return sent;
    }

    // ── round management ──────────────────────────────────────

    /** Create a new round, push to history, set as current. */
    newRound(msgId) {
        const round = new Round({
            msgId: msgId ?? createMessageId(),
            delivery: this._rawSend.bind(this),
            agentFrom: this.agentFrom
        });
        this._rounds.push(round);
        this.current = round;
        console.log(`[agentthere:round] ${Date.now()} newRound msgId=${round.msgId} totalRounds=${this._rounds.length}`);
        return round;
    }

    // ── access historical rounds ──────────────────────────────

    getRound(msgId) {
        return this._rounds.find(r => r.msgId === msgId);
    }

    getRounds() {
        return this._rounds;
    }

    // ── convenience delegation to current round ───────────────

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

    ensureTextSegment() {
        return this.current?.ensureTextSegment();
    }

    sealTextSegment() {
        return this.current?.sealTextSegment();
    }

    nextSid() {
        return this.current?.nextSid();
    }

    _patch(ops) {
        return this.current?._patch(ops);
    }

    markOldestToolPhase(phase) {
        return this.current?.markOldestToolPhase(phase);
    }

    sendNote(text) {
        return this.current?.sendNote(text);
    }

    sendError(message) {
        return this.current?.sendError(message);
    }

    sendMedia({ rawUrl, kind }) {
        return this.current?.sendMedia({ rawUrl, kind, groupId: this._groupId, peerId: this._peerId });
    }

    stageMediaKey(rawUrl) {
        return this.current?.stageMediaKey(rawUrl);
    }

    // ── current-round state delegates ─────────────────────────
    get mediaTokenSeen() {
        return this.current?.mediaTokenSeen;
    }
    set mediaTokenSeen(v) {
        if (this.current) this.current.mediaTokenSeen = v;
    }
    get sentMediaKeys() {
        return this.current?.sentMediaKeys;
    }
    get streamed() {
        return this.current?.streamed;
    }
    set streamed(v) {
        if (this.current) this.current.streamed = v;
    }
    get lastAccText() {
        return this.current?.lastAccText ?? '';
    }
    set lastAccText(v) {
        if (this.current) this.current.lastAccText = v;
    }
    get lastReasoningText() {
        return this.current?.lastReasoningText ?? '';
    }
    set lastReasoningText(v) {
        if (this.current) this.current.lastReasoningText = v;
    }
    get placeholderSent() {
        return this.current?.placeholderSent;
    }
    get lastToolSid() {
        return this.current?.lastToolSid;
    }
    set lastToolSid(v) {
        if (this.current) this.current.lastToolSid = v;
    }
    get pendingToolSids() {
        return this.current?.pendingToolSids;
    }
}

export { Round };
