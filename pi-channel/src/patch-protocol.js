/**
 * Converts Pi agent events into AgentThere _patch protocol messages.
 *
 * The _patch protocol uses JSON Patch-like operations to incrementally
 * build a reply message with ordered segments (reasoning, text, and tool calls) in the browser.
 */
import { createMessageId } from "./channel/messaging.js";
// ── reply tracker ──────────────────────────────────────────────────────
let _sidCounter = 0;
// ── public API ──────────────────────────────────────────────────────────
export function createReplyTracker(agentProfile, modelInfo, msgId) {
    _sidCounter += 1;
    return {
        msgId: msgId ?? createMessageId(),
        agentProfile,
        modelInfo,
        segments: [],
        reasoningSid: null,
        loading: true,
    };
}
/** Build the initial placeholder + model_info messages. */
export function buildPlaceholder(reply) {
    const messages = [];
    // Placeholder
    messages.push(JSON.stringify({
        id: reply.msgId,
        text: "",
        from: { ...reply.agentProfile, agent: true },
        loading: true,
    }));
    // Model info (optional)
    if (reply.modelInfo) {
        messages.push(JSON.stringify({
            id: reply.msgId,
            model_info: reply.modelInfo,
        }));
    }
    return messages;
}
/** Append a text chunk to the current text segment or create a new one. */
export function appendTextChunk(reply, chunk) {
    if (!chunk)
        return null;
    // Find last text segment
    const lastText = [...reply.segments]
        .reverse()
        .find((s) => s.kind === "text");
    const patches = [];
    if (!lastText || lastText.complete) {
        // Create new text segment
        _sidCounter += 1;
        const sid = `s${_sidCounter}`;
        const newSeg = {
            sid,
            kind: "text",
            text: "",
            complete: false,
        };
        reply.segments.push(newSeg);
        patches.push({ op: "push", path: "segments", value: newSeg });
        patches.push({
            op: "append_text",
            path: `segments[sid=${sid}].text`,
            chunk,
        });
    }
    else {
        lastText.text += chunk;
        patches.push({
            op: "append_text",
            path: `segments[sid=${lastText.sid}].text`,
            chunk,
        });
    }
    return { id: reply.msgId, _patch: patches };
}
/** Mark the current text segment as complete. */
export function completeTextSegment(reply) {
    const lastText = [...reply.segments]
        .reverse()
        .find((s) => s.kind === "text" && !s.complete);
    if (!lastText)
        return null;
    lastText.complete = true;
    return {
        id: reply.msgId,
        _patch: [
            {
                op: "merge",
                path: `segments[sid=${lastText.sid}]`,
                value: { complete: true },
            },
        ],
    };
}
/** Start a tool call segment. */
export function startToolSegment(reply, toolName, argsSummary) {
    _sidCounter += 1;
    const sid = `s${_sidCounter}`;
    const seg = {
        sid,
        kind: "tool",
        name: toolName,
        argsSummary,
        phase: "start",
        status: "running",
        events: [],
    };
    reply.segments.push(seg);
    return {
        id: reply.msgId,
        _patch: [{ op: "push", path: "segments", value: seg }],
    };
}
/** Push a tool output event. */
export function pushToolEvent(reply, toolName, event) {
    // Find the active tool segment
    const toolSeg = [...reply.segments]
        .reverse()
        .find((s) => s.kind === "tool" && s.name === toolName && s.status === "running");
    if (!toolSeg)
        return null;
    toolSeg.events.push(event);
    toolSeg.phase = "stream";
    return {
        id: reply.msgId,
        _patch: [
            {
                op: "push",
                path: `segments[sid=${toolSeg.sid}].events`,
                value: event,
            },
        ],
    };
}
/** Mark a tool segment as complete. */
export function completeToolSegment(reply, toolName, isError = false) {
    const toolSeg = [...reply.segments]
        .reverse()
        .find((s) => s.kind === "tool" && s.name === toolName && s.status === "running");
    if (!toolSeg)
        return null;
    toolSeg.status = isError ? "error" : "done";
    toolSeg.phase = "done";
    return {
        id: reply.msgId,
        _patch: [
            {
                op: "merge",
                path: `segments[sid=${toolSeg.sid}]`,
                value: {
                    status: toolSeg.status,
                    phase: toolSeg.phase,
                },
            },
        ],
    };
}
/** Append reasoning text into the ordered segments stream. */
export function appendReasoning(reply, chunk) {
    if (!chunk)
        return null;

    let reasoning = reply.reasoningSid
        ? reply.segments.find((segment) => segment.sid === reply.reasoningSid && segment.kind === "reasoning")
        : null;
    const patches = [];

    if (!reasoning || reasoning.complete) {
        _sidCounter += 1;
        reasoning = {
            sid: `s${_sidCounter}`,
            kind: "reasoning",
            text: "",
            complete: false,
        };
        reply.reasoningSid = reasoning.sid;
        reply.segments.push(reasoning);
        patches.push({ op: "push", path: "segments", value: reasoning });
    }

    reasoning.text += chunk;
    patches.push({
        op: "append_text",
        path: `segments[sid=${reasoning.sid}].text`,
        chunk,
    });
    return { id: reply.msgId, _patch: patches };
}
/** Mark the active reasoning segment as complete. */
export function completeReasoning(reply) {
    if (!reply.reasoningSid)
        return null;
    const reasoning = reply.segments.find(
        (segment) => segment.sid === reply.reasoningSid && segment.kind === "reasoning",
    );
    reply.reasoningSid = null;
    if (!reasoning || reasoning.complete)
        return null;
    reasoning.complete = true;
    return {
        id: reply.msgId,
        _patch: [
            {
                op: "merge",
                path: `segments[sid=${reasoning.sid}]`,
                value: { complete: true },
            },
        ],
    };
}
/** Finalize the reply — loading: false + usage. */
export function finalizeReply(reply, usage, contextInfo) {
    reply.loading = false;
    reply.usage = usage;
    const patches = [
        { op: "set", path: "loading", value: false },
    ];
    if (usage) {
        const usageValue = {
            input: usage.input,
            output: usage.output,
            total: usage.totalTokens, // Pi uses totalTokens → map to total (AgentThere)
            cache_read: usage.cacheRead ?? 0, // camelCase → snake_case for client
            cache_write: usage.cacheWrite ?? 0,
        };
        // Extra Pi fields not in AgentThere spec
        if (usage.reasoning != null)
            usageValue.reasoning = usage.reasoning;
        if (usage.cost)
            usageValue.cost = usage.cost;
        // Context window info (session-level)
        if (contextInfo) {
            usageValue.context_percent = contextInfo.percent;
            usageValue.context_window = contextInfo.contextWindow;
        }
        patches.push({
            op: "set",
            path: "usage",
            value: usageValue,
        });
    }
    return [{ id: reply.msgId, _patch: patches }];
}
// ── tool args summary helper ────────────────────────────────────────────
export function summarizeArgs(args) {
    const keys = Object.keys(args).filter((k) => k !== "command" && k !== "edits");
    if (keys.length === 0) {
        if (args.command)
            return String(args.command).slice(0, 80);
        return "";
    }
    return keys
        .map((k) => {
        const v = args[k];
        if (typeof v === "string")
            return `${k}=${v.slice(0, 40)}`;
        if (Array.isArray(v))
            return `${k}=[${v.length} items]`;
        return `${k}=…`;
    })
        .join(", ");
}
