const FOLLOW_UP_WINDOW_MS = 60_000;
const stateBySession = new WeakMap();

function getState(req) {
    const session = req.$agent_session.session;
    let state = stateBySession.get(session);
    if (!state) {
        state = { lastReplyByUid: new Map() };
        stateBySession.set(session, state);
    }
    return state;
}

function decide(req, lastReplyByUid) {
    const groupId = req.$group.groupId;
    const { peerId, uid } = req.$peer;
    const message = req.$message;
    if (message?.type === "file") return false;
    if (peerId === "system" || !groupId) return true;
    if (req.$group.getPeerCount(groupId) <= 1) return true;

    const text = String(message?.text ?? "");
    const agentName = req.$agent_session.getAgentProfile()?.name;
    if (agentName && text.includes(`@${agentName}`)) return true;

    if (uid) {
        const lastReply = lastReplyByUid.get(uid);
        if (lastReply && Date.now() - lastReply < FOLLOW_UP_WINDOW_MS) return true;
    }
    return false;
}

export async function intentDetection(req, res, next) {
    const state = getState(req);
    req.$mentioned = decide(req, state.lastReplyByUid);
    await next();
    if (req.$mentioned && req.$authResult?.allowed && req.$peer.uid) {
        state.lastReplyByUid.set(req.$peer.uid, Date.now());
    }
}
