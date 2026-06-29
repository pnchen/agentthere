import {
    buildPendingHistoryContextFromMap,
    clearHistoryEntries,
    recordPendingHistoryEntryIfEnabled
} from 'openclaw/plugin-sdk/reply-history';

const groupHistories = new Map();
const GROUP_HISTORY_LIMIT = 50;

export async function historyContext(ctx, next) {
    if (!ctx.groupId) {
        await next();
        return;
    }

    const historyKey = `agentthere:group:${ctx.groupId}`;
    const effectiveMentioned = ctx.mentioned || ctx.isFollowUp;

    // ── unmentioned → record to pending history ──
    if (!effectiveMentioned) {
        const mediaUrl = ctx.mediaUrl?.startsWith('file://') ? ctx.mediaUrl.slice(7) : ctx.mediaUrl;
        const historyBody = mediaUrl ? [ctx.text, `[附件: ${ctx.fileName ?? 'file'}]`, `MEDIA:${mediaUrl}`].join('\n') : ctx.text;

        recordPendingHistoryEntryIfEnabled({
            historyMap: groupHistories,
            historyKey,
            limit: GROUP_HISTORY_LIMIT,
            entry: { sender: ctx.peerName, body: historyBody, timestamp: Date.now() }
        });
        return; // short-circuit
    }

    // ── mentioned → build combined context ──
    const formatEntry = e => {
        const ts = e.timestamp
            ? new Date(e.timestamp).toLocaleTimeString('zh-CN', {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false
              })
            : '';
        return ts ? `[${ts}] ${e.sender}: ${e.body}` : `${e.sender}: ${e.body}`;
    };

    ctx.getCombinedBody = currentText => {
        const body = buildPendingHistoryContextFromMap({
            historyMap: groupHistories,
            historyKey,
            limit: GROUP_HISTORY_LIMIT,
            currentMessage: currentText,
            formatEntry
        });
        clearHistoryEntries({ historyMap: groupHistories, historyKey });
        return body;
    };

    await next();
}
