/**
 * ReplyRenderer — converts Pi AgentSession events into AgentThere _patch protocol.
 *
 * Requires an explicit Round (set via setRound). Text/command routes create a
 * Round before prompt; voice calls set one with TTS enabled.
 */

// ── patch helpers ───────────────────────────────────────────────────────

function buildPlaceholder(round) {
    if (round.placeholderSent) round.reopenLoading();
    else round.sendPlaceholder();
    if (round.modelInfo) {
        round.send({ id: round.msgId, model_info: round.modelInfo });
    }
}

function isTranscriptSegment(segment) {
    return segment.kind === "text" && String(segment.sid).startsWith("t");
}

function appendTextChunk(round, chunk) {
    if (!chunk) return null;
    const lastText = [...round.segments].reverse().find((s) => s.kind === "text" && !isTranscriptSegment(s));
    const patches = [];
    if (!lastText || lastText.complete) {
        const sid = round.nextSid();
        const seg = { sid, kind: "text", text: "", complete: false };
        round.segments.push(seg);
        patches.push({ op: "push", path: "segments", value: seg });
        patches.push({ op: "append_text", path: `segments[sid=${sid}].text`, chunk });
    }
    else {
        lastText.text += chunk;
        patches.push({ op: "append_text", path: `segments[sid=${lastText.sid}].text`, chunk });
    }
    return { id: round.msgId, _patch: patches };
}

function completeTextSegment(round) {
    const seg = [...round.segments].reverse().find((s) => s.kind === "text" && !isTranscriptSegment(s) && !s.complete);
    if (!seg) return null;
    seg.complete = true;
    return { id: round.msgId, _patch: [{ op: "merge", path: `segments[sid=${seg.sid}]`, value: { complete: true } }] };
}

function startToolSegment(round, toolName, argsSummary) {
    const sid = round.nextSid();
    const seg = { sid, kind: "tool", name: toolName, argsSummary, phase: "start", status: "running", events: [] };
    round.segments.push(seg);
    return { id: round.msgId, _patch: [{ op: "push", path: "segments", value: seg }] };
}

function pushToolEvent(round, toolName, event) {
    const seg = [...round.segments].reverse().find((s) => s.kind === "tool" && s.name === toolName && s.status === "running");
    if (!seg) return null;
    seg.events.push(event);
    seg.phase = "stream";
    return { id: round.msgId, _patch: [{ op: "push", path: `segments[sid=${seg.sid}].events`, value: event }] };
}

function completeToolSegment(round, toolName, isError = false) {
    const seg = [...round.segments].reverse().find((s) => s.kind === "tool" && s.name === toolName && s.status === "running");
    if (!seg) return null;
    seg.status = isError ? "error" : "done";
    seg.phase = "done";
    return { id: round.msgId, _patch: [{ op: "merge", path: `segments[sid=${seg.sid}]`, value: { status: seg.status, phase: seg.phase } }] };
}

function appendReasoning(round, chunk) {
    if (!chunk) return null;
    let reasoning = round.reasoningSid
        ? round.segments.find((s) => s.sid === round.reasoningSid && s.kind === "reasoning")
        : null;
    const patches = [];
    if (!reasoning || reasoning.complete) {
        const sid = round.nextSid();
        reasoning = { sid, kind: "reasoning", text: "", complete: false };
        round.reasoningSid = sid;
        round.segments.push(reasoning);
        patches.push({ op: "push", path: "segments", value: reasoning });
    }
    reasoning.text += chunk;
    patches.push({ op: "append_text", path: `segments[sid=${reasoning.sid}].text`, chunk });
    return { id: round.msgId, _patch: patches };
}

function completeReasoning(round) {
    if (!round.reasoningSid) return null;
    const reasoning = round.segments.find((s) => s.sid === round.reasoningSid && s.kind === "reasoning");
    round.reasoningSid = null;
    if (!reasoning || reasoning.complete) return null;
    reasoning.complete = true;
    return { id: round.msgId, _patch: [{ op: "merge", path: `segments[sid=${reasoning.sid}]`, value: { complete: true } }] };
}

function finalizeReply(round, usage, contextInfo) {
    round.usage = usage;
    const patches = [];
    if (usage) {
        const v = {
            input: usage.input, output: usage.output, total: usage.totalTokens,
            cache_read: usage.cacheRead ?? 0, cache_write: usage.cacheWrite ?? 0,
        };
        if (usage.reasoning != null) v.reasoning = usage.reasoning;
        if (usage.cost) v.cost = usage.cost;
        if (contextInfo) { v.context_percent = contextInfo.percent; v.context_window = contextInfo.contextWindow; }
        patches.push({ op: "set", path: "usage", value: v });
    }
    return patches.length > 0 ? [{ id: round.msgId, _patch: patches }] : [];
}

function summarizeArgs(args) {
    const keys = Object.keys(args).filter((k) => k !== "command" && k !== "edits");
    if (keys.length === 0) return args.command ? String(args.command).slice(0, 80) : "";
    return keys.map((k) => {
        const v = args[k];
        if (typeof v === "string") return `${k}=${v.slice(0, 40)}`;
        if (Array.isArray(v)) return `${k}=[${v.length} items]`;
        return `${k}=…`;
    }).join(", ");
}

// ── ReplyRenderer ───────────────────────────────────────────────────────

export class ReplyRenderer {
    constructor({ agentFrom, output = null, tts = null, getThinkLevel = () => "", getContextUsage = null }) {
        this.agentFrom = agentFrom;
        this.output = output;
        this.tts = tts;
        this.getThinkLevel = getThinkLevel;
        this.getContextUsage = getContextUsage;
        this.round = null;
        this.inAssistantMessage = false;
        this.sentTextLength = 0;
        this.cumulativeUsage = null;
        this.toolCallIds = new Map();
    }

    // ── round target ─────────────────────────────────────────────────
    setRound(round, tts = null) {
        // Kept for callers outside the unified Group output path.
        this.round = round;
        this.tts = tts;
    }

    clearRound() {
        this.round = null;
        this.tts = null;
    }

    // ── event dispatch ────────────────────────────────────────────────
    handle(event) {
        switch (event.type) {
            case "agent_start": this._handleAgentStart(); break;
            case "agent_end": this._handleAgentEnd(); break;
            case "message_start": this._handleMessageStart(event); break;
            case "message_update": this._handleMessageUpdate(event); break;
            case "message_end": this._handleMessageEnd(event); break;
            case "tool_execution_start": this._handleToolStart(event); break;
            case "tool_execution_update": this._handleToolUpdate(event); break;
            case "tool_execution_end": this._handleToolEnd(event); break;
        }
    }

    emit(message) {
        if (!message) return;
        if (this.round) this.round.send(message);
        else this.output?.send(message);
    }

    // ── handlers ──────────────────────────────────────────────────────
    _handleAgentStart() {
        this.round = this.output?.ensureRound?.() || this.round;
        if (!this.round) return;
        this.round.resetReplyState();
        this.inAssistantMessage = false;
        this.sentTextLength = 0;
        this.cumulativeUsage = null;
        this.toolCallIds.clear();
        buildPlaceholder(this.round);
    }

    _handleAgentEnd() {
        if (!this.round) return;
        this.emit(completeTextSegment(this.round));
        this.inAssistantMessage = false;
        this.emit(completeReasoning(this.round));
        this.output?.flushTts?.();
        this.tts?.onFlush?.();
        const contextInfo = typeof this.getContextUsage === "function" ? this.getContextUsage() : null;
        for (const m of finalizeReply(this.round, this.cumulativeUsage ?? this.round.usage, contextInfo)) {
            this.emit(m);
        }
        this.output?.onAgentEnd?.();
        if (this.round?._finalized) this.round = null;
    }

    _handleMessageStart(event) {
        if (!this.round || event.message.role !== "assistant") return;
        this.inAssistantMessage = true;
        this.sentTextLength = 0;
        if (!this.round.modelInfo && (event.message.provider || event.message.model)) {
            const provider = event.message.provider || "";
            const model = event.message.model || "unknown";
            this.round.modelInfo = {
                model: provider ? `${provider}/${model}` : model,
                provider,
                thinkLevel: this.getThinkLevel() || "",
            };
            this.emit({ id: this.round.msgId, model_info: this.round.modelInfo });
        }
    }

    _handleMessageUpdate(event) {
        if (!this.round || event.message.role !== "assistant") return;
        let fullText = "";
        if (Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
                if (block.type === "text" && block.text) fullText = block.text;
            }
        }
        const ae = event.assistantMessageEvent;
        if (ae?.type === "thinking_delta" && ae.delta) {
            const chunk = typeof ae.delta === "string" ? ae.delta : ae.delta.text ?? "";
            if (chunk) this.emit(appendReasoning(this.round, chunk));
        }
        if (ae?.type === "thinking_end") this.emit(completeReasoning(this.round));
        if (!fullText || !this.inAssistantMessage) return;
        const delta = fullText.slice(this.sentTextLength);
        this.sentTextLength = fullText.length;
        if (delta) {
            this.output?.emitTtsDelta?.(delta);
            this.tts?.onDelta?.(delta);
        }
        const lastText = [...this.round.segments].reverse().find((s) => s.kind === "text" && !isTranscriptSegment(s) && !s.complete);
        if (lastText) {
            lastText.text = fullText;
            this.emit({ id: this.round.msgId, _patch: [{ op: "merge", path: `segments[sid=${lastText.sid}]`, value: { text: fullText } }] });
        }
        else {
            this.emit(appendTextChunk(this.round, delta));
        }
    }

    _handleMessageEnd(event) {
        if (!this.round || event.message.role !== "assistant") return;
        this.emit(completeTextSegment(this.round));
        this.inAssistantMessage = false;
        this._addUsage(event.message.usage);
    }

    _handleToolStart(event) {
        if (!this.round) return;
        this.toolCallIds.set(event.toolName, event.toolCallId);
        if (this.inAssistantMessage) {
            this.emit(completeTextSegment(this.round));
            this.inAssistantMessage = false;
            this.sentTextLength = 0;
        }
        this.emit(startToolSegment(this.round, event.toolName, summarizeArgs(event.args)));
    }

    _handleToolUpdate(event) {
        if (!this.round) return;
        const output = event.partialResult?.content
            ?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") || "";
        if (output) this.emit(pushToolEvent(this.round, event.toolName, { kind: "command", output }));
    }

    _handleToolEnd(event) {
        if (!this.round) return;
        const output = event.result?.content
            ?.filter((c) => c.type === "text").map((c) => c.text ?? "").join("") || "";
        if (output) {
            this.emit(pushToolEvent(this.round, event.toolName, {
                kind: "command", output,
                exitCode: event.result?.details?.exitCode ?? (event.isError ? 1 : 0),
            }));
        }
        this.emit(completeToolSegment(this.round, event.toolName, event.isError ?? false));
        this.toolCallIds.delete(event.toolName);
    }

    _addUsage(usage) {
        if (!usage) return;
        const inc = { input: usage.input ?? 0, output: usage.output ?? 0, totalTokens: usage.totalTokens ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, cost: usage.cost };
        if (!this.cumulativeUsage) { this.cumulativeUsage = inc.cost ? { ...inc, cost: { ...inc.cost } } : inc; return; }
        this.cumulativeUsage.input += inc.input;
        this.cumulativeUsage.output += inc.output;
        this.cumulativeUsage.totalTokens += inc.totalTokens;
        this.cumulativeUsage.cacheRead += inc.cacheRead;
        this.cumulativeUsage.cacheWrite += inc.cacheWrite;
        if (inc.cost && this.cumulativeUsage.cost) {
            this.cumulativeUsage.cost.input += inc.cost.input;
            this.cumulativeUsage.cost.output += inc.cost.output;
            this.cumulativeUsage.cost.cacheRead += inc.cost.cacheRead;
            this.cumulativeUsage.cost.cacheWrite += inc.cost.cacheWrite;
            this.cumulativeUsage.cost.total += inc.cost.total;
        }
        else if (inc.cost) { this.cumulativeUsage.cost = { ...inc.cost }; }
    }
}
