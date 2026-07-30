const GROUP_HISTORY_LIMIT = 50;
const stateBySession = new WeakMap();

function getState(req) {
    const session = req.$agent_session.session;
    let state = stateBySession.get(session);
    if (!state) {
        state = { histories: new Map() };
        stateBySession.set(session, state);
    }
    return state;
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

function describeMessage(message) {
    if (!message) return "";
    if (message.type === "text") return String(message.text ?? "").trim();
    if (message.type === "file") {
        const name = String(message.name ?? "file");
        const filePath = String(message.path ?? "");
        return filePath
            ? `User sent a file named "${name}". File path: ${filePath}`
            : `User sent a file named "${name}".`;
    }
    return "";
}

function formatEntry(entry) {
    const timestamp = new Date(entry.timestamp).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    });
    const body = describeMessage(entry.message);
    return body ? `[${timestamp}] [user=${entry.sender}] ${body}` : "";
}

function recordPending(state, req) {
    const message = normalizeMessage(req.$message);
    if (!message) return;

    const key = String(req.$group.groupId);
    const entries = state.histories.get(key) ?? [];
    entries.push({ sender: req.$peer.peerName, message, timestamp: Date.now() });
    if (entries.length > GROUP_HISTORY_LIMIT) {
        entries.splice(0, entries.length - GROUP_HISTORY_LIMIT);
    }
    state.histories.set(key, entries);
}

function consumePending(state, req, currentMessage) {
    const key = String(req.$group.groupId);
    const entries = state.histories.get(key) ?? [];
    state.histories.delete(key);

    const lines = entries.map(formatEntry);
    const current = normalizeMessage(currentMessage);
    if (current) {
        lines.push(formatEntry({
            sender: req.$peer.peerName,
            message: current,
            timestamp: Date.now(),
        }));
    }
    return lines.filter(Boolean).join("\n\n");
}

export async function historyContext(req, res, next) {
    const state = getState(req);
    if (!req.$mentioned) {
        recordPending(state, req);
        console.log(`[agentthere:history] queued group=${req.$group.groupId} peerId=${req.$peer.peerId}`);
        res.status(202).json({ accepted: true, queued: true });
        return;
    }

    req.$getCombinedBody = (message = req.$message) =>
        consumePending(state, req, message);
    await next();
}
