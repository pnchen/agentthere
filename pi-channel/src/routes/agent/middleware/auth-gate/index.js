import { getConfig } from "../../../../config.js";
import { checkUserAccess, registerPendingUser } from "./userlist.js";

export async function authGate(req, res, next) {
    const groupId = req.$group.groupId;
    const groupConfig = getConfig().groups?.[groupId] ?? {};
    const agentKey = req.$agent_session.agentKey;
    const agentName = req.$agent_session.getAgentProfile().name;
    const uid = req.$peer.uid;
    const agentLabel = `"${agentName || "unknown"}"`;
    const agentId = `"${agentKey || "unknown"}"`;
    const access = groupConfig.access ?? "allowlist";

    if (access === "open") {
        req.$authResult = { allowed: true };
        await next();
        return;
    }

    if (!uid) {
        req.$authResult = { allowed: false, reason: "missing_uid" };
        res.status(403).json({ accepted: false, auth: req.$authResult });
        return;
    }

    if (access === "disabled") {
        console.log(`[agentthere:auth] blocked uid=${uid} reason=disabled`);
        req.$authResult = { allowed: false, reason: "disabled" };
        req.$peer.send(JSON.stringify({
            type: "system",
            text: "[AgentThere] This group is currently disabled.",
        }));
        res.status(403).json({ accepted: false, auth: req.$authResult });
        return;
    }

    const allowFrom = groupConfig.allow_from ?? groupConfig.allowFrom ?? [];
    const result = checkUserAccess(uid, allowFrom, agentKey);
    if (result.authorized) {
        req.$authResult = { allowed: true };
        await next();
        return;
    }

    if (result.reason === "agent_not_allowed") {
        console.log(`[agentthere:auth] blocked uid=${uid} agent=${agentKey} reason=agent_not_allowed`);
        req.$authResult = { allowed: false, reason: "agent_not_allowed" };
        req.$peer.send(JSON.stringify({
            type: "system",
            text: `[AgentThere] You are not authorized to access Agent ${agentLabel}.`,
        }));
    }
    else if (result.reason === "pending") {
        console.log(`[agentthere:auth] pending uid=${uid}`);
        req.$authResult = { allowed: false, reason: "pending", pair_code: result.pair_code };
        req.$peer.send(JSON.stringify({
            type: "system",
            text:
                `[AgentThere] Your access request for Agent ${agentLabel} is pending. ` +
                `Please ask the administrator to authorize user **${uid}** for Agent ${agentId} ` +
                `with pair code: **${result.pair_code}**`,
        }));
    }
    else {
        const alias = req.$peer.peerName || "";
        const pairCode = registerPendingUser(uid, alias, agentKey);
        console.log(`[agentthere:auth] not-registered uid=${uid} pairCode=${pairCode}`);
        req.$authResult = { allowed: false, reason: "not_registered", pair_code: pairCode };
        req.$peer.send(JSON.stringify({
            type: "system",
            text: pairCode
                ? `[AgentThere] Welcome! You are not yet authorized to access Agent ${agentLabel}. ` +
                  `Please ask the administrator to authorize user **${uid}** for Agent ${agentId} ` +
                  `with pair code: **${pairCode}**`
                : `[AgentThere] Unable to register your access request.`,
        }));
    }

    if (!res.headersSent) res.status(403).json({ accepted: false, auth: req.$authResult });
}
