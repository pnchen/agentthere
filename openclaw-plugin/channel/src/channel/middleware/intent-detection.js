/**
 * Intent detection middleware.
 *
 * Determines whether an incoming message is intended for the agent.
 * DM / one-to-one always passes. Group messages pass when:
 *   - Only one other peer (just the user + agent, like a DM)
 *   - Explicit @mention
 *   - Within the follow-up window (60s since agent last replied to that user)
 */

const FOLLOW_UP_WINDOW_MS = 60_000;
const _lastReplyMap = new Map();

export async function intentDetection(ctx, next) {
    // File-only messages → not mentioned, let historyContext record them
    if (ctx.mediaUrl) {
        ctx.mentioned = false;
        ctx.cleanText = ctx.text;
        await next();
        return;
    }

    // System messages always pass
    if (ctx.peerId === 'system') {
        ctx.mentioned = true;
        ctx.cleanText = ctx.text;
        await next();
        return;
    }

    // DM — always intended for the agent
    if (!ctx.groupId) {
        ctx.mentioned = true;
        ctx.cleanText = ctx.text;
        await next();
        if (ctx.uid) _lastReplyMap.set(ctx.uid, Date.now());
        return;
    }

    const mentionPrefix = `@${ctx.agentProfile?.name}`;

    // Group with only one other peer — treat like DM
    if (ctx.peerCount <= 1) {
        ctx.mentioned = true;
        ctx.cleanText = ctx.text.includes(mentionPrefix) ? ctx.text.replace(mentionPrefix, '').trim() || ctx.text : ctx.text;
        await next();
        if (ctx.uid) _lastReplyMap.set(ctx.uid, Date.now());
        return;
    }

    // Group — check explicit @mention
    const mentionedExplicit = ctx.text.includes(mentionPrefix);

    if (mentionedExplicit) {
        ctx.mentioned = true;
        ctx.cleanText = ctx.text.replace(mentionPrefix, '').trim() || ctx.text;
        await next();
        if (ctx.uid) _lastReplyMap.set(ctx.uid, Date.now());
        return;
    }

    // Group — check follow-up window (user recently replied to)
    if (ctx.uid) {
        const lastReply = _lastReplyMap.get(ctx.uid);
        const isFollowUp = Boolean(lastReply && Date.now() - lastReply < FOLLOW_UP_WINDOW_MS);

        if (isFollowUp) {
            ctx.mentioned = true;
            ctx.cleanText = ctx.text;
            await next();
            return;
        }
    }

    // Not intended for agent — pass to historyContext to record, then short-circuit
    ctx.mentioned = false;
    ctx.cleanText = ctx.text;
    await next();
}
