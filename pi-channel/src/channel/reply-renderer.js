import {
    createReplyTracker,
    buildPlaceholder,
    appendTextChunk,
    completeTextSegment,
    startToolSegment,
    pushToolEvent,
    completeToolSegment,
    appendReasoning,
    completeReasoning,
    finalizeReply,
    summarizeArgs,
} from "../patch-protocol.js";

/**
 * Shared AgentSession event -> AgentThere reply renderer.
 *
 * The output sink decides where patches go. TTS is an optional second sink;
 * text replies use only patches, while voice replies enable TTS callbacks.
 */
export class ReplyRenderer {
    constructor({ agentFrom, replyId, send, tts = null, getThinkLevel = () => "", getContextUsage = null }) {
        this.agentFrom = agentFrom;
        this.replyId = replyId;
        this._send = send;
        this.tts = tts;
        this.getThinkLevel = getThinkLevel;
        this.getContextUsage = getContextUsage;
        this.replyTracker = null;
        this.inAssistantMessage = false;
        this.sentTextLength = 0;
        this.cumulativeUsage = null;
        this.toolCallIds = new Map();
    }

    handle(event) {
        switch (event.type) {
            case "agent_start":
                this.handleAgentStart();
                break;
            case "agent_end":
                this.handleAgentEnd();
                break;
            case "message_start":
                this.handleMessageStart(event);
                break;
            case "message_update":
                this.handleMessageUpdate(event);
                break;
            case "message_end":
                this.handleMessageEnd(event);
                break;
            case "tool_execution_start":
                this.handleToolExecutionStart(event);
                break;
            case "tool_execution_update":
                this.handleToolExecutionUpdate(event);
                break;
            case "tool_execution_end":
                this.handleToolExecutionEnd(event);
                break;
            default:
                break;
        }
    }

    handleAgentStart() {
        const profile = typeof this.agentFrom === "function" ? this.agentFrom() : this.agentFrom;
        this.replyTracker = createReplyTracker(
            profile,
            null,
            typeof this.replyId === "function" ? this.replyId() : this.replyId,
        );
        this.inAssistantMessage = false;
        this.sentTextLength = 0;
        this.cumulativeUsage = null;
        this.toolCallIds.clear();
        for (const message of buildPlaceholder(this.replyTracker)) {
            this.emit(JSON.parse(message));
        }
    }

    handleAgentEnd() {
        if (!this.replyTracker) return;
        this.emit(completeTextSegment(this.replyTracker));
        this.inAssistantMessage = false;
        this.emit(completeReasoning(this.replyTracker));
        this.tts?.onFlush?.();
        const contextInfo = typeof this.getContextUsage === "function" ? this.getContextUsage() : null;
        for (const message of finalizeReply(this.replyTracker, this.cumulativeUsage ?? this.replyTracker.usage, contextInfo)) {
            this.emit(message);
        }
        this.replyTracker = null;
    }

    handleMessageStart(event) {
        if (!this.replyTracker || event.message.role !== "assistant") return;
        this.inAssistantMessage = true;
        this.sentTextLength = 0;
        if (!this.replyTracker.modelInfo && (event.message.provider || event.message.model)) {
            const provider = event.message.provider || "";
            const model = event.message.model || "unknown";
            this.replyTracker.modelInfo = {
                model: provider ? `${provider}/${model}` : model,
                provider,
                thinkLevel: this.getThinkLevel() || "",
            };
            this.emit({ id: this.replyTracker.msgId, model_info: this.replyTracker.modelInfo });
        }
    }

    handleMessageUpdate(event) {
        if (!this.replyTracker || event.message.role !== "assistant") return;

        let fullText = "";
        if (Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
                if (block.type === "text" && block.text) fullText = block.text;
            }
        }

        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent?.type === "thinking_delta" && assistantEvent.delta) {
            const chunk = typeof assistantEvent.delta === "string"
                ? assistantEvent.delta
                : assistantEvent.delta.text ?? "";
            if (chunk) this.emit(appendReasoning(this.replyTracker, chunk));
        }
        if (assistantEvent?.type === "thinking_end") {
            this.emit(completeReasoning(this.replyTracker));
        }

        if (!fullText || !this.inAssistantMessage) return;
        const delta = fullText.slice(this.sentTextLength);
        this.sentTextLength = fullText.length;
        if (delta) this.tts?.onDelta?.(delta);

        const lastText = [...this.replyTracker.segments]
            .reverse()
            .find((segment) => segment.kind === "text" && !segment.complete);
        if (lastText) {
            lastText.text = fullText;
            this.emit({
                id: this.replyTracker.msgId,
                _patch: [{
                    op: "merge",
                    path: `segments[sid=${lastText.sid}]`,
                    value: { text: fullText },
                }],
            });
        }
        else {
            this.emit(appendTextChunk(this.replyTracker, delta));
        }
    }

    handleMessageEnd(event) {
        if (!this.replyTracker || event.message.role !== "assistant") return;
        this.emit(completeTextSegment(this.replyTracker));
        this.inAssistantMessage = false;
        // Keep the speech pipeline open across assistant messages. Pi may
        // emit several assistant messages around tool calls; flushing here
        // creates tiny TTS requests and breaks sentence continuity.
        this.addUsage(event.message.usage);
    }

    handleToolExecutionStart(event) {
        if (!this.replyTracker) return;
        this.toolCallIds.set(event.toolName, event.toolCallId);
        if (this.inAssistantMessage) {
            this.emit(completeTextSegment(this.replyTracker));
            this.inAssistantMessage = false;
            this.sentTextLength = 0;
        }
        this.emit(startToolSegment(this.replyTracker, event.toolName, summarizeArgs(event.args)));
    }

    handleToolExecutionUpdate(event) {
        if (!this.replyTracker) return;
        const output = event.partialResult?.content
            ?.filter((content) => content.type === "text")
            .map((content) => content.text ?? "")
            .join("") || "";
        if (output) this.emit(pushToolEvent(this.replyTracker, event.toolName, { kind: "command", output }));
    }

    handleToolExecutionEnd(event) {
        if (!this.replyTracker) return;
        const output = event.result?.content
            ?.filter((content) => content.type === "text")
            .map((content) => content.text ?? "")
            .join("") || "";
        if (output) {
            this.emit(pushToolEvent(this.replyTracker, event.toolName, {
                kind: "command",
                output,
                exitCode: event.result?.details?.exitCode ?? (event.isError ? 1 : 0),
            }));
        }
        this.emit(completeToolSegment(this.replyTracker, event.toolName, event.isError ?? false));
        this.toolCallIds.delete(event.toolName);
    }

    addUsage(usage) {
        if (!usage) return;
        const inc = {
            input: usage.input ?? 0,
            output: usage.output ?? 0,
            totalTokens: usage.totalTokens ?? 0,
            cacheRead: usage.cacheRead ?? 0,
            cacheWrite: usage.cacheWrite ?? 0,
            cost: usage.cost,
        };
        if (!this.cumulativeUsage) {
            this.cumulativeUsage = inc.cost ? { ...inc, cost: { ...inc.cost } } : inc;
            return;
        }
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
        else if (inc.cost) {
            this.cumulativeUsage.cost = { ...inc.cost };
        }
    }

    emit(message) {
        if (message) this._send(message);
    }
}
