/**
 * Intent detection middleware.
 *
 * Reads the generic ctx.message fact and decides whether this message should
 * continue to authGate / Agent. State is isolated by AgentSession.
 */

const FOLLOW_UP_WINDOW_MS = 60_000;
const stateBySession = new WeakMap();

function getState(ctx) {
    let state = stateBySession.get(ctx.session);
    if (!state) {
        state = { lastReplyByUid: new Map() };
        stateBySession.set(ctx.session, state);
    }
    return state;
}

export async function intentDetection(ctx, next) {
    const state = getState(ctx);
    const result = ctx.isCommand
        ? { mentioned: true }
        : decide(ctx, state.lastReplyByUid);

    ctx.mentioned = result.mentioned;
    await next();

    if (result.mentioned && ctx.authResult?.allowed && ctx.uid) {
        state.lastReplyByUid.set(ctx.uid, Date.now());
    }
}

function decide(ctx, lastReplyByUid) {
    const { groupId, peerId, uid } = ctx;
    const message = ctx.message;

    // A file is a local history event. It does not trigger an Agent turn.
    if (message?.type === "file") {
        return { mentioned: false };
    }

    if (peerId === "system" || !groupId) {
        return { mentioned: true };
    }

    const peerCount = Number(ctx.peerCount ?? 0);
    if (peerCount <= 1) {
        return { mentioned: true };
    }

    const text = String(message?.text ?? "");
    const agentName = ctx.agentProfile?.name;
    const mention = agentName ? `@${agentName}` : "";
    if (mention && text.includes(mention)) {
        return { mentioned: true };
    }

    if (uid) {
        const lastReply = lastReplyByUid.get(uid);
        if (lastReply && Date.now() - lastReply < FOLLOW_UP_WINDOW_MS) {
            return { mentioned: true };
        }
    }

    return { mentioned: false };
}
