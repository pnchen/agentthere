/**
 * Message history middleware.
 *
 * The route context carries a generic message fact:
 *   { type: "text", text }
 *   { type: "file", name, path }
 *
 * History stores those facts without turning them into prompt text. The
 * prompt body is generated lazily by ctx.getCombinedBody() after authGate
 * allows the request. State is isolated by AgentSession.
 */

const GROUP_HISTORY_LIMIT = 50;
const stateBySession = new WeakMap();

function getState(ctx) {
    let state = stateBySession.get(ctx.session);
    if (!state) {
        state = { histories: new Map() };
        stateBySession.set(ctx.session, state);
    }
    return state;
}

export async function historyContext(ctx, next) {
    const state = getState(ctx);

    if (!ctx.mentioned) {
        recordPending(state, ctx);
        console.log(`[agentthere:history] queued group=${ctx.groupId} peerId=${ctx.peerId}`);
        return;
    }

    // Do not consume here. A file can arrive between two call transcripts;
    // the next terminal prompt must see it through this lazy accessor.
    ctx.getCombinedBody = (currentMessage) => consumePending(state, {
        groupId: ctx.groupId,
        sender: ctx.peerName,
        currentMessage,
    });

    await next();
}

function recordPending(state, ctx) {
    const message = normalizeMessage(ctx.message);
    if (!ctx.groupId || !message) return;

    const key = String(ctx.groupId);
    const entries = state.histories.get(key) ?? [];
    entries.push({
        sender: ctx.peerName,
        message,
        timestamp: Date.now(),
    });
    if (entries.length > GROUP_HISTORY_LIMIT) {
        entries.splice(0, entries.length - GROUP_HISTORY_LIMIT);
    }
    state.histories.set(key, entries);
}

function consumePending(state, { groupId, sender, currentMessage }) {
    const key = String(groupId);
    const entries = state.histories.get(key) ?? [];
    state.histories.delete(key);

    const lines = entries.map((entry) => formatEntry(entry));
    const current = normalizeMessage(currentMessage);
    if (current) {
        lines.push(formatEntry({ sender, message: current, timestamp: Date.now() }));
    }
    return lines.filter(Boolean).join("\n\n");
}

function formatEntry(entry) {
    const timestamp = new Date(entry.timestamp).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
    const body = describeMessage(entry.message);
    return body ? `[${timestamp}] ${entry.sender}: ${body}` : "";
}

function describeMessage(message) {
    if (!message || typeof message !== "object") return "";

    if (message.type === "text") {
        return String(message.text ?? "").trim();
    }

    if (message.type === "file") {
        const name = String(message.name ?? "file");
        const filePath = String(message.path ?? "");
        return filePath
            ? `用户发来了一个文件，文件名是 "${name}"，文件路径是：${filePath}`
            : `用户发来了一个文件，文件名是 "${name}"`;
    }

    return "";
}

function normalizeMessage(message) {
    if (!message || typeof message !== "object") return null;
    if (message.type === "text") {
        const text = String(message.text ?? "").trim();
        return text ? { type: "text", text } : null;
    }
    if (message.type === "file") {
        return {
            type: "file",
            name: String(message.name ?? "file"),
            path: String(message.path ?? ""),
        };
    }
    return null;
}
