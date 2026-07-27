/**
 * Outbound file transfer over WebRTC DataChannel.
 *
 * Chunked-Base64 protocol: metadata → chunks.
 * Adapted from openclaw-plugin/channel/src/channel/file-send.js
 * Replaced resolvePreferredOpenClawTmpDir with os.tmpdir().
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getGroupPeers, getPeerByPeerId } from "./rtc/index.js";
import { createMessageId } from "./channel/messaging.js";
const CHUNK_SIZE = 65536;
const BUFFERED_AMOUNT_THRESHOLD = 256 * 1024;
// ── backpressure ───────────────────────────────────────────────────────
function waitForDrain(dc, timeoutMs = 30_000) {
    return new Promise((resolve) => {
        if (!dc || !dc.isOpen())
            return resolve(false);
        if (dc.bufferedAmount() < BUFFERED_AMOUNT_THRESHOLD)
            return resolve(true);
        dc.setBufferedAmountLowThreshold(BUFFERED_AMOUNT_THRESHOLD);
        let settled = false;
        const settle = (v) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                clearInterval(check);
                resolve(v);
            }
        };
        const timer = setTimeout(() => settle(false), timeoutMs);
        dc.onBufferedAmountLow(() => settle(dc.isOpen()));
        const check = setInterval(() => {
            if (!dc.isOpen())
                settle(false);
            else if (dc.bufferedAmount() < BUFFERED_AMOUNT_THRESHOLD)
                settle(true);
        }, 200);
    });
}
// ── chunk send ─────────────────────────────────────────────────────────
async function sendChunks(peer, objectId, fileBuffer, fileSize, log) {
    log?.(`[pi-channel/file] chunks start peer=${peer.peerId} object=${objectId} bytes=${fileSize}`);
    let offset = 0;
    while (offset < fileSize) {
        if (!peer.isConnected()) {
            log?.(`[pi-channel/file] ${peer.peerId} disconnected at offset ${offset}/${fileSize}`);
            return false;
        }
        if (!(await waitForDrain(peer.dc))) {
            log?.(`[pi-channel/file] ${peer.peerId} drain timeout at offset ${offset}/${fileSize}`);
            return false;
        }
        const end = Math.min(offset + CHUNK_SIZE, fileSize);
        const chunkMsg = JSON.stringify({
            object_id: objectId,
            chunk: {
                object_id: objectId,
                offset,
                data: fileBuffer.subarray(offset, end).toString("base64"),
            },
        });
        if (!peer.send(chunkMsg)) {
            log?.(`[pi-channel/file] ${peer.peerId} send failed at offset ${offset}/${fileSize}`);
            return false;
        }
        offset = end;
    }
    log?.(`[pi-channel/file] chunks complete peer=${peer.peerId} object=${objectId} bytes=${fileSize}`);
    return true;
}
// ── send to peers ──────────────────────────────────────────────────────
async function _sendToPeers({ filePath, fileName, mimeType, peerList, agentProfile, log, kind, }) {
    log?.(`[pi-channel/file] begin path="${filePath}" file="${fileName}" mime=${mimeType} peers=${peerList.map((p) => `${p.peerId}:connected=${p.connected}:dc=${!!p.dc}:open=${p.dc?.isOpen?.()}`).join(",")}`);
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const objectId = randomUUID().replace(/-/g, "").slice(0, 16);
    const messageId = createMessageId();
    const meta = {
        id: messageId,
        file: { name: fileName, size: fileSize, type: mimeType },
        object_id: objectId,
        from: agentProfile,
    };
    if (kind)
        meta.kind = kind;
    for (const p of peerList) {
        const sent = p.send(JSON.stringify(meta));
        log?.(`[pi-channel/file] metadata peer=${p.peerId} sent=${sent}`);
        if (!sent) return { ok: false, messageId, objectId };
    }
    log?.(`[pi-channel/file] metadata for "${fileName}" (${fileSize} bytes, ${peerList.length} peers)`);
    const fileBuffer = fs.readFileSync(filePath);
    const results = await Promise.allSettled(peerList.map((p) => sendChunks(p, objectId, fileBuffer, fileSize, log)));
    const ok = results.filter((r) => r.status === "fulfilled" && r.value === true).length > 0;
    log?.(`[pi-channel/file] sent "${fileName}" — ${ok ? "ok" : "incomplete"}`);
    return { ok, messageId, objectId };
}
// ── public entry point ─────────────────────────────────────────────────
export async function sendMedia({ rawUrl, groupId, peerId, agentProfile, kind, }) {
    const log = (msg) => console.error(msg);
    log(`[pi-channel/file] sendMedia rawUrl="${rawUrl}" groupId=${groupId ?? ""} peerId=${peerId ?? ""}`);
    const filePath = await downloadHttpToTmp(rawUrl);
    const fileName = extractDisplayName(filePath);
    const mimeType = resolveMimeType(fileName);
    log(`[pi-channel/file] resolved filePath="${filePath}" fileName="${fileName}" mime=${mimeType}`);
    if (groupId) {
        const peerList = getGroupPeers(groupId);
        log(`[pi-channel/file] eligible peers group=${groupId} count=${peerList.length} ids=${peerList.map((p) => p.peerId).join(",")}`);
        if (!peerList.length)
            return { ok: false, messageId: createMessageId(), objectId: "" };
        return _sendToPeers({
            filePath,
            fileName,
            mimeType,
            peerList,
            agentProfile,
            log,
            kind,
        });
    }
    const peer = getPeerByPeerId(peerId ?? "");
    if (!peer)
        return { ok: false, messageId: createMessageId(), objectId: "" };
    return _sendToPeers({
        filePath,
        fileName,
        mimeType,
        peerList: [peer],
        agentProfile,
        log,
        kind,
    });
}
// ── MIME ───────────────────────────────────────────────────────────────
const MIME_MAP = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".zip": "application/zip",
};
function resolveMimeType(fileName) {
    return MIME_MAP[path.extname(fileName).toLowerCase()] || "application/octet-stream";
}
function extractDisplayName(filePath) {
    const rawBase = path.basename(filePath);
    return rawBase.replace(/---[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\.[^.]+)?$/i, "$1");
}
async function downloadHttpToTmp(rawUrl) {
    let filePath = rawUrl.startsWith("file://") ? rawUrl.slice(7) : rawUrl;
    if (!/^https?:\/\//i.test(filePath))
        return filePath;
    const resp = await fetch(filePath);
    if (!resp.ok)
        throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    const { URL } = await import("node:url");
    const urlName = path.basename(new URL(filePath).pathname) || "download";
    const tmpDir = path.join(os.tmpdir(), "pi-channel-files");
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `dl-${Date.now()}-${urlName}`);
    fs.writeFileSync(tmpPath, buf);
    return tmpPath;
}
