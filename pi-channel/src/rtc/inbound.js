/**
 * RTC DataChannel inbound protocol.
 *
 * Parses messages received from remote peers, reassembles incoming files, and
 * forwards completed messages to the local Agent HTTP API. This layer knows
 * about RTC peers and the HTTP boundary, but not Agent tasks or sessions.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getConfig, resolveAgentWorkspaceDir } from "../config.js";
import { registerCallStream } from "./call-streams.js";

const inFlightTransfers = new Map();

export async function handleInboundStream(groupId, streamHandle, peer) {
    const streamId = registerCallStream(streamHandle);
    const response = await fetch("http://127.0.0.1:9001/agent/call", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "X-AgentThere-Group-Id": groupId,
            "X-AgentThere-Peer-Id": peer.peerId,
        },
        body: JSON.stringify({ streamId }),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Agent HTTP ${response.status}: ${body}`);
    }
}

export async function handleRawMessage(groupId, raw, peer) {
    const peerId = peer.peerId;
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        parsed = { text: raw };
    }

    // Profile exchange belongs to the RTC protocol. It only updates the
    // remote Peer metadata and never needs to reach the Agent task.
    if (parsed.type === "profile") {
        const profile = parsed.profile;
        if (profile?.name) peer.peerName = profile.name;
        if (parsed.uid) peer.uid = parsed.uid;
        return;
    }

    if (parsed.file && parsed.object_id) {
        registerIncomingFile({ file: parsed.file, object_id: parsed.object_id }, groupId, peer);
        return;
    }

    if (parsed.chunk && parsed.object_id) {
        const completed = handleFileChunk(parsed.object_id, parsed.chunk);
        if (completed) {
            handleInboundFile(completed).catch((error) => {
                console.error(`[pi-channel:rtc] inbound file failed: ${String(error)}`);
            });
        }
        return;
    }

    const text = parsed.text != null ? String(parsed.text).trim() : "";
    if (!text) return;

    console.log(`[pi-channel:rtc] message from ${peer.peerName}: ${text.slice(0, 80)}`);
    const endpoint = text.startsWith("/") ? "/agent/command" : "/agent/message";
    const response = await fetch(`http://127.0.0.1:9001${endpoint}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "X-AgentThere-Group-Id": groupId,
            "X-AgentThere-Peer-Id": peerId,
        },
        body: JSON.stringify({
            message: { type: "text", text },
        }),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Agent HTTP ${response.status}: ${body}`);
    }
}

function registerIncomingFile(meta, groupId, peer) {
    const { object_id: objectId } = meta;
    if (inFlightTransfers.has(objectId)) return;

    inFlightTransfers.set(objectId, {
        meta,
        groupId,
        peerId: peer.peerId,
        peerName: peer.peerName,
        uid: peer.uid,
        chunks: [],
        received: 0,
    });
    console.log(`[pi-channel:rtc] receiving "${meta.file.name}" (${meta.file.size} bytes) object_id=${objectId}`);

    const timer = setTimeout(() => {
        if (!inFlightTransfers.has(objectId)) return;
        console.warn(`[pi-channel:rtc] transfer ${objectId} timed out, discarding`);
        inFlightTransfers.delete(objectId);
    }, 5 * 60 * 1000);
    timer.unref?.();
}

function handleFileChunk(objectId, chunk) {
    const transfer = inFlightTransfers.get(objectId);
    if (!transfer) return null;

    const data = Buffer.from(chunk.data, "base64");
    transfer.chunks.push({ offset: chunk.offset, data });
    transfer.received += data.length;
    if (transfer.received < transfer.meta.file.size) return null;

    transfer.chunks.sort((a, b) => a.offset - b.offset);
    const buffer = Buffer.concat(transfer.chunks.map((item) => item.data), transfer.meta.file.size);
    inFlightTransfers.delete(objectId);
    console.log(`[pi-channel:rtc] completed "${transfer.meta.file.name}" (${buffer.length} bytes)`);
    return {
        groupId: transfer.groupId,
        peerId: transfer.peerId,
        peerName: transfer.peerName,
        uid: transfer.uid,
        fileName: transfer.meta.file.name,
        mimeType: transfer.meta.file.type || "application/octet-stream",
        buffer,
    };
}

async function handleInboundFile(file) {
    const { groupId, peerId, peerName, fileName, mimeType, buffer } = file;
    console.log(`[pi-channel:rtc] inbound file from ${peerName}: ${fileName} (${buffer.length} bytes)`);

    const config = getConfig();
    const agentName = config.groups?.[groupId]?.agent;
    const workspaceDir = agentName
        ? resolveAgentWorkspaceDir(config, agentName)
        : path.join(os.tmpdir(), "pi-channel-files");
    const incomingDir = path.join(workspaceDir, "incoming");
    fs.mkdirSync(incomingDir, { recursive: true });

    const parsed = path.parse(fileName || "file");
    const safeName = (parsed.name || "file").replace(/[\/\\:*?"<>|]/g, "_");
    const ext = parsed.ext || "";
    const savedPath = path.join(incomingDir, `${safeName}---${randomUUID()}${ext}`);
    fs.writeFileSync(savedPath, buffer);

    const response = await fetch("http://127.0.0.1:9001/agent/message", {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "X-AgentThere-Group-Id": groupId,
            "X-AgentThere-Peer-Id": peerId,
        },
        body: JSON.stringify({
            message: {
                type: "file",
                name: fileName,
                path: savedPath,
            },
        }),
    });
    if (!response.ok) {
        const body = await response.text();
        throw new Error(`Agent HTTP ${response.status}: ${body}`);
    }
    console.log(`[pi-channel:rtc] file routed through HTTP group=${groupId} peerId=${peerId} path=${savedPath}`);
}
