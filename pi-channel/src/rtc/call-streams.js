import { randomUUID } from "node:crypto";

const streams = new Map();
const STREAM_TTL_MS = 60_000;

export function registerCallStream(streamHandle) {
    const streamId = randomUUID();
    const timer = setTimeout(() => {
        const entry = streams.get(streamId);
        if (entry?.streamHandle === streamHandle) streams.delete(streamId);
    }, STREAM_TTL_MS);
    timer.unref?.();
    streams.set(streamId, { streamHandle, timer });
    return streamId;
}

export function takeCallStream(streamId) {
    const entry = streams.get(String(streamId));
    if (!entry) return null;
    streams.delete(String(streamId));
    clearTimeout(entry.timer);
    return entry.streamHandle;
}

export function discardCallStream(streamId) {
    const entry = streams.get(String(streamId));
    if (!entry) return;
    streams.delete(String(streamId));
    clearTimeout(entry.timer);
}
