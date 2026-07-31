/**
 * record_topic — custom tool for Pi SDK mode.
 *
 * Lets the LLM record a topic change when the conversation shifts to a new
 * subject or reaches a key decision point.
 *
 * The topic is persisted as a custom_message entry in the session JSONL so
 * that session listings can display the current topic without re-reading the
 * full conversation.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export function createRecordTopicTool(deps) {
    return defineTool({
        name: "record_topic",
        label: "Record Topic",
        description:
            "Record a topic summary for the current session. Call this when the conversation " +
            "shifts to a new subject or a significant decision has been reached. " +
            "The topic should be a concise summary (≤20 characters recommended) of what is " +
            "being discussed right now.",
        parameters: Type.Object({
            topic: Type.String({
                description:
                    "A concise summary of the current discussion topic. " +
                    "Should be short and descriptive, e.g. 'TTS idle lifecycle', " +
                    "'Session metadata design', 'ffmpeg seek races'.",
            }),
        }),
        async execute(toolCallId, params, _signal, _onUpdate, _ctx) {
            const topic = String(params.topic).trim();
            if (!topic) {
                throw new Error("topic must be a non-empty string");
            }
            deps.getSession()?.sessionManager?.appendCustomMessageEntry(
                "agentthere.topic",
                [{ type: "text", text: topic }],
                false,
                { topic },
            );
            console.log(`[pi-channel/topic-tool] recorded topic="${topic}"`);
            return {
                content: [{ type: "text", text: `Topic recorded: ${topic}` }],
                details: { topic },
            };
        },
    });
}
