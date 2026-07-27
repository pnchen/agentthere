/**
 * SDK Bridge — connects Pi SDK AgentSession to WebRTC DataChannel peers.
 *
 * Responsibilities:
 *   1. Receive text/images/files from browser peers → send to AgentSession
 *   2. Subscribe to AgentSession events → convert to AgentThere _patch protocol
 *   3. Broadcast _patch messages to connected peers
 *
 * Bridges AgentThere WebRTC peers to Pi SDK AgentSession.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { callHandler } from "./channel/route/call/index.js";
import { messageHandler } from "./channel/route/message.js";
import { ReplyCoordinator } from "./channel/reply-coordinator.js";
import { ReplyRenderer } from "./channel/reply-renderer.js";
import { Router } from "./channel/router/index.js";
import { historyContext } from "./channel/middleware/history-context.js";
import { intentDetection } from "./channel/middleware/intent-detection.js";
import { authGate } from "./channel/middleware/auth-gate/index.js";
import { isKnownCommand } from "./command-registry.js";

// ── mismatch log ────────────────────────────────────────────────────────
const mismatches = [];
export function getMismatches() {
    return mismatches;
}
function logMismatch(msg) {
    mismatches.push(`[${new Date().toISOString()}] ${msg}`);
    console.warn(`[pi-channel:sdk-bridge:mismatch] ${msg}`);
}
// ── SdkBridge ───────────────────────────────────────────────────────────
export class SdkBridge {
    session;
    getGroup;
    groupId;
    agentProfile;
    workspaceDir;
    sttConfig;
    ttsConfig;
    peerContext;
    activeReply = null;
    replyCoordinator;
    replyRenderer;
    // Inbound file transfers and pending group history
    inFlightTransfers = new Map();
    router;
    constructor(opts) {
        this.session = opts.session;
        this.getGroup = opts.getGroup;
        this.groupId = opts.groupId;
        this.agentProfile = opts.agentProfile;
        this.workspaceDir = opts.workspaceDir;
        this.getSttConfig = opts.getSttConfig;
        this.getTtsConfig = opts.getTtsConfig;
        this.agentConfigSync = opts.agentConfigSync || (async () => {});
        this.peerContext = opts.peerContext;
        this.resourceLoader = opts.resourceLoader;
        this.getGroupConfig = opts.getGroupConfig || (() => ({}));
        // Stable configuration alias, not the public IDENTITY.md name.
        this.agentKey = opts.agentKey || null;
        this.router = new Router();
        this.router.use(
            "/message",
            intentDetection,
            historyContext,
            authGate,
            messageHandler,
        );
        this.router.use(
            "/call",
            historyContext,
            authGate,
            callHandler,
        );
        this.replyRenderer = new ReplyRenderer({
            agentFrom: () => this.agentProfile,
            send: (message) => this.getGroup()?.send(JSON.stringify(message)),
            getThinkLevel: () => this.session.thinkingLevel,
            getContextUsage: () => this.session.getContextUsage?.(),
        });
        this.replyCoordinator = new ReplyCoordinator(
            this.session,
            (event) => this.handleSessionEvent(event),
            (event) => {
                if (event.type === "agent_end") {
                    this.resourceLoader?.reload().catch((err) => {
                        console.warn(`[pi-channel:sdk-bridge] skill reload failed: ${String(err)}`);
                    });
                }
            },
        );
    }
    // ── start / stop ─────────────────────────────────────────────────────
    start({ wireMonitors = true } = {}) {
        this.replyCoordinator.start();
        if (wireMonitors) this.wireMonitors();
        console.log("[pi-channel:sdk-bridge] started");
    }
    stop() {
        this.replyCoordinator.stop();
        this.activeReply = null;
        this.inFlightTransfers.clear();

        console.log("[pi-channel:sdk-bridge] stopped");
    }
    setPeerContext(groupId, peer) {
        if (!this.peerContext) return;
        this.peerContext.current = {
            groupId,
            peerId: peer.peerId,
            peerName: peer.peerName,
            uid: peer.uid,
        };
    }

    clearPeerContext(peerId) {
        if (this.peerContext?.current?.peerId === peerId) {
            this.peerContext.current = null;
        }
    }

    /** Voice call temporarily owns the shared agent event stream. */
    setVoiceReplyRound(round, onEvent) {
        this.replyCoordinator.setVoiceReply(round, onEvent);
    }

    /** Clear voice reply ownership, optionally only for a specific round. */
    clearVoiceReplyRound(round) {
        this.replyCoordinator.clearVoiceReply(round);
    }

    /** Update this Runtime's profile. The owning monitor broadcasts it. */
    updateIdentity(identity) {
        this.agentProfile.name = identity.name;
        if (identity.avatar) this.agentProfile.avatar = identity.avatar;
        else delete this.agentProfile.avatar;
        this.agentProfile.agent = true;
    }
    /** Expose agent profile for tool usage. */
    getAgentProfile() {
        return this.agentProfile;
    }
    getGroupIds() {
        return [this.groupId];
    }

    createRouteContext(pathname, opts) {
        const group = this.getGroup();
        const res = opts.res ?? group.createResponse({
            peerId: opts.peer?.peerId ?? opts.peerId,
            agentFrom: { ...this.agentProfile, agent: true },
        });
        return {
            path: pathname,
            ...opts,
            uid: opts.uid ?? opts.peer?.uid ?? null,
            peerName: opts.peerName ?? opts.peer?.peerName,
            peerCount: opts.peerCount ?? group.getPeerCount(opts.groupId),
            groupConfig: this.getGroupConfig(opts.groupId),
            agentKey: this.agentKey,
            session: this.session,
            agentProfile: this.agentProfile,
            agentName: this.agentProfile.name,
            res,
        };
    }

    // ── inbound: channel → AgentSession ──────────────────────────────────
    async handleInboundStream(groupId, streamHandle, peer) {
        await this.agentConfigSync();
        const ctx = this.createRouteContext("/call", {
            groupId,
            peer,
            message: { type: "call", streamHandle },
            mentioned: true,
            peerCount: this.getGroup()?.getPeerCount(groupId) ?? 0,
            peerId: peer.peerId,
            peerName: peer.peerName,
            uid: peer.uid,
            streamHandle,
            sttConfig: this.getSttConfig(),
            ttsConfig: this.getTtsConfig(),
            bridge: this,
        });
        await this.router.process("/call", ctx);
    }

    async handleRawMessage(raw, peer, groupId) {
        const peerId = peer.peerId;
        try {
            await this.agentConfigSync();
        }
        catch (err) {
            console.warn(`[pi-channel:sdk-bridge] config sync failed: ${String(err)}`);
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            parsed = { text: raw };
        }
        // Profile exchange
        if (parsed.type === "profile") {
            const profile = parsed.profile;
            if (profile?.name)
                peer.peerName = profile.name;
            if (parsed.uid)
                peer.uid = parsed.uid;
            return;
        }
        // File metadata
        if (parsed.file && parsed.object_id) {
            const objectId = parsed.object_id;
            const file = parsed.file;
            this.registerIncomingFile({ file, object_id: objectId }, groupId, peerId, peer.peerName, peer.uid);
            return;
        }
        // File chunk
        if (parsed.chunk && parsed.object_id) {
            const chunk = parsed.chunk;
            const completed = this.handleFileChunk(chunk.object_id, chunk);
            if (completed) {
                this.handleInboundFile(completed.groupId, completed.fileName, completed.buffer, completed.mimeType, completed.peerId, completed.peerName, completed.uid).catch((err) => {
                    console.error(`[pi-channel:sdk-bridge] handleInboundFile failed: ${String(err)}`);
                });
            }
            return;
        }
        // Text message
        const text = parsed.text != null ? String(parsed.text).trim() : "";
        if (!text)
            return;
        console.log(`[pi-channel:sdk-bridge] message from ${peer.peerName}: ${text.slice(0, 80)}`);
        const isCommand = isKnownCommand(this.session, text);
        const ctx = this.createRouteContext("/message", {
            groupId,
            peer,
            peerId,
            peerName: peer.peerName,
            uid: peer.uid,
            message: { type: "text", text },
            isCommand,
        });
        this.setPeerContext(groupId, peer);
        await this.router.process("/message", ctx);
        this.clearPeerContext(peerId);
    }
    // ── inbound file helpers ─────────────────────────────────────────────
    registerIncomingFile(meta, groupId, peerId, peerName, uid) {
        const { object_id } = meta;
        if (this.inFlightTransfers.has(object_id))
            return;
        this.inFlightTransfers.set(object_id, {
            meta,
            groupId,
            peerId,
            peerName,
            uid,
            chunks: [],
            received: 0,
            startedAt: Date.now(),
        });
        console.log(`[pi-channel:sdk-bridge] receiving "${meta.file.name}" (${meta.file.size} bytes) object_id=${object_id}`);
        setTimeout(() => {
            if (this.inFlightTransfers.has(object_id)) {
                console.warn(`[pi-channel:sdk-bridge] transfer ${object_id} timed out, discarding`);
                this.inFlightTransfers.delete(object_id);
            }
        }, 5 * 60 * 1000);
    }
    handleFileChunk(objectId, chunk) {
        const transfer = this.inFlightTransfers.get(objectId);
        if (!transfer)
            return null;
        const data = Buffer.from(chunk.data, "base64");
        transfer.chunks.push({ offset: chunk.offset, data });
        transfer.received += data.length;
        if (transfer.received >= transfer.meta.file.size) {
            transfer.chunks.sort((a, b) => a.offset - b.offset);
            const fullBuffer = Buffer.concat(transfer.chunks.map((c) => c.data), transfer.meta.file.size);
            this.inFlightTransfers.delete(objectId);
            console.log(`[pi-channel:sdk-bridge] completed "${transfer.meta.file.name}" (${fullBuffer.length} bytes)`);
            return {
                buffer: fullBuffer,
                fileName: transfer.meta.file.name,
                mimeType: transfer.meta.file.type || "application/octet-stream",
                size: transfer.meta.file.size,
                groupId: transfer.groupId,
                peerId: transfer.peerId,
                peerName: transfer.peerName,
                uid: transfer.uid,
            };
        }
        return null;
    }
    async handleInboundFile(groupId, fileName, buffer, mimeType, peerId, peerName, uid) {
        console.log(`[pi-channel:sdk-bridge] inbound file from ${peerName}: ${fileName} (${buffer.length} bytes)`);
        const incomingDir = this.workspaceDir
            ? path.join(this.workspaceDir, "incoming")
            : path.join(os.tmpdir(), "pi-channel-files");
        fs.mkdirSync(incomingDir, { recursive: true });
        const parsed = path.parse(fileName || "file");
        const safeName = (parsed.name || "file").replace(/[\/\\:*?"<>|]/g, "_");
        const ext = parsed.ext || "";
        const savedPath = path.join(incomingDir, `${safeName}---${randomUUID()}${ext}`);
        fs.writeFileSync(savedPath, buffer);
        const ctx = this.createRouteContext("/message", {
            groupId,
            peerId,
            peerName,
            uid,
            message: {
                type: "file",
                name: fileName,
                path: savedPath,
            },
            isCommand: false,
        });
        this.setPeerContext(groupId, { peerId, peerName, uid });
        await this.router.process("/message", ctx);
        this.clearPeerContext(peerId);
        console.log(`[pi-channel:sdk-bridge] file routed through message pipeline group=${groupId} peerId=${peerId} path=${savedPath}`);
    }
    // ── outbound: AgentSession events → _patch ───────────────────────────
    handleSessionEvent(event) {
        this.replyRenderer.handle(event);
    }
    // Reply delivery belongs to the Group communication object.

}
