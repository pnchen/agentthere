/**
 * Group TTS output.
 *
 * Agent reply text is queued here and spoken to the currently connected RTC
 * peers. TTS is an output channel, not part of the call/STT input route.
 */

import { MediaOutSender } from "../media-out.js";
import { getGroup } from "../index.js";
import {
    ensureTtsConsumer,
    closeTtsQueue,
    cancelTtsQueue,
    pushTtsDelta,
    pushTtsFlush,
    isTtsQueueIdle,
} from "./queue.js";

const IDLE_MS = 15_000;

export class OutboundTts {
    constructor({ groupId, getConfig }) {
        this.groupId = groupId;
        this._getConfig = getConfig;
        this._targets = new Map();
        this._active = false;
        this._idleTimer = null;
    }

    activate() {
        this._active = true;
        this._clearIdleTimer();
    }

    _clearIdleTimer() {
        if (this._idleTimer) {
            clearTimeout(this._idleTimer);
            this._idleTimer = null;
        }
    }

    _ensureTarget(peer) {
        if (!this._active) return null;
        const config = typeof this._getConfig === "function" ? this._getConfig() : this._getConfig;
        if (!config || config.enabled === false || !peer?.peerId) return null;

        const previous = this._targets.get(peer.peerId);
        if (previous?.peer === peer) return previous;
        previous?.close();

        const mediaOut = new MediaOutSender(peer.peerId, this.groupId);
        ensureTtsConsumer(peer.peerId, {
            ttsConfig: config,
            onIdle: () => this._scheduleIdleClose(),
            onPcm: (pcm) => mediaOut.play(pcm),
            onStop: () => mediaOut.stop(),
            onResume: () => mediaOut.resume(),
            onError: (error) => console.error(`[agentthere:tts] ${error}`),
        });

        const target = {
            peer,
            push: (text) => pushTtsDelta(peer.peerId, text),
            flush: () => pushTtsFlush(peer.peerId),
            interrupt: () => cancelTtsQueue(peer.peerId, () => mediaOut.stop()),
            isIdle: () => isTtsQueueIdle(peer.peerId),
            close: () => {
                closeTtsQueue(peer.peerId);
                mediaOut.close();
            },
        };
        this._targets.set(peer.peerId, target);
        return target;
    }

    _forEachTarget(action, ...args) {
        const peers = getGroup(this.groupId)?.getPeers?.() || [];
        for (const peer of peers) this._ensureTarget(peer)?.[action](...args);
    }

    push(text) {
        if (!this._active || !text) return;
        this._clearIdleTimer();
        this._forEachTarget("push", text);
    }

    flush() {
        if (!this._active) return;
        for (const target of this._targets.values()) target.flush();
        this._scheduleIdleClose();
    }

    interrupt() {
        for (const target of this._targets.values()) target.interrupt();
        this._scheduleIdleClose();
    }

    _scheduleIdleClose() {
        this._clearIdleTimer();
        this._idleTimer = setTimeout(() => {
            this._idleTimer = null;
            if (!this._active) return;
            if ([...this._targets.values()].some((target) => !target.isIdle())) {
                this._scheduleIdleClose();
                return;
            }
            this.close();
        }, IDLE_MS);
    }

    deactivate() {
        this.close();
    }

    close() {
        this._clearIdleTimer();
        this._active = false;
        for (const target of this._targets.values()) target.close();
        this._targets.clear();
    }
}
