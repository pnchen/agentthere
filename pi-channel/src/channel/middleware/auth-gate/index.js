/**
 * Auth Gate middleware — group-level access control.
 *
 * (ctx, next) middleware:
 *   - open       → next()
 *   - disabled   → reply + short-circuit
 *   - allowlist  → check static allowFrom + dynamic users.jsonl
 *     - authorized → next()
 *     - pending    → reply pair_code + short-circuit
 *     - unknown    → register, reply pair_code + short-circuit
 *
 * ctx must provide:
 *   ctx.uid          — peer identity (peerName)
 *   ctx.groupConfig  — live group entry { access?, allowFrom? }
 *   ctx.agentKey     — config Agent key (group is intentionally ignored)
 *   ctx.res          — OutboundResponse for reply
 */
import { checkUserAccess, registerPendingUser } from "./userlist.js";

export async function authGate(ctx, next) {
    const { uid, groupConfig, agentKey, agentName } = ctx;
    const agentLabel = `"${agentName || "unknown"}"`;
    const agentId = `"${agentKey || "unknown"}"`;
    const access = groupConfig?.access ?? "allowlist";

    if (access === "open") {
        ctx.authResult = { allowed: true };
        await next();
        return;
    }

    if (!uid) return; // silent drop

    if (access === "disabled") {
        console.log(`[agentthere:auth] blocked uid=${uid} reason=disabled`);
        ctx.authResult = { allowed: false, reason: "disabled" };
        ctx.res?.send({
            type: "system",
            text: "[AgentThere] This group is currently disabled.",
        });
        return;
    }

    // allowlist
    const allowFrom = groupConfig?.allow_from ?? groupConfig?.allowFrom ?? [];
    const result = checkUserAccess(uid, allowFrom, agentKey);

    if (result.authorized) {
        ctx.authResult = { allowed: true };
        await next();
        return;
    }

    if (result.reason === "agent_not_allowed") {
        console.log(`[agentthere:auth] blocked uid=${uid} agent=${agentKey} reason=agent_not_allowed`);
        ctx.authResult = { allowed: false, reason: "agent_not_allowed" };
        ctx.res?.send({
            type: "system",
            text: `[AgentThere] You are not authorized to access Agent ${agentLabel}.`,
        });
        return;
    }

    if (result.reason === "pending") {
        console.log(`[agentthere:auth] pending uid=${uid}`);
        ctx.authResult = { allowed: false, reason: "pending", pair_code: result.pair_code };
        ctx.res?.send({
            type: "system",
            text:
                `[AgentThere] Your access request for Agent ${agentLabel} is pending. ` +
                `Please ask the administrator to authorize user **${uid}** for Agent ${agentId} ` +
                `with pair code: **${result.pair_code}**`,
        });
        return;
    }

    // Not registered → register
    const alias = ctx.peerName || "";
    const pairCode = registerPendingUser(uid, alias, agentKey);
    console.log(`[agentthere:auth] not-registered uid=${uid} pairCode=${pairCode}`);
    ctx.authResult = { allowed: false, reason: "not_registered", pair_code: pairCode };
    ctx.res?.send({
        type: "system",
        text: pairCode
            ? `[AgentThere] Welcome! You are not yet authorized to access Agent ${agentLabel}. ` +
              `Please ask the administrator to authorize user **${uid}** for Agent ${agentId} ` +
              `with pair code: **${pairCode}**`
            : `[AgentThere] Unable to register your access request.`,
    });
}
