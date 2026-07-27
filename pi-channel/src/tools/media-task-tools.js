import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";

function resolveSource(source, cwd) {
    if (/^https?:\/\//i.test(source)) return source;
    return path.isAbsolute(source) ? source : path.resolve(cwd, source);
}

export function createMediaTaskTools(manager, deps) {
    const playMedia = defineTool({
        name: "play_media",
        label: "Play Media",
        description: "Start a background media playback task for the current AgentThere peer context and stream its audio and video over WebRTC. The task returns immediately; use stop_media or media_status to control it.",
        parameters: Type.Object({
            source: Type.String({ description: "Local video path or HTTP(S) media URL" }),
            group_id: Type.Optional(Type.String({ description: "Target AgentThere group ID" })),
            fps: Type.Optional(Type.Number({ description: "Video frame rate for the H264 transport (default: 30)" })),
            loop: Type.Optional(Type.Boolean({ description: "Loop playback after the source ends" })),
        }),
        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
            const peerContext = deps.getPeerContext();
            const groupId = params.group_id ?? peerContext?.groupId;
            if (!groupId) throw new Error("No active AgentThere peer context");
            const source = resolveSource(params.source, typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd());
            console.log(`[pi-channel/media-tool] play_media toolCallId=${toolCallId} group=${groupId} source=${source}`);
            const task = await manager.start({
                source,
                groupId,
                fps: params.fps,
                loop: params.loop,
            });
            return {
                content: [{ type: "text", text: `Started media task ${task.taskId} for group "${groupId}"` }],
                details: task.status(),
            };
        },
    });

    const stopMedia = defineTool({
        name: "stop_media",
        label: "Stop Media",
        description: "Stop a background AgentThere media playback task.",
        parameters: Type.Object({
            task_id: Type.String({ description: "Media task ID returned by play_media" }),
        }),
        async execute(_toolCallId, params) {
            const stopped = manager.stop(params.task_id);
            if (!stopped) throw new Error(`Media task not found: ${params.task_id}`);
            return {
                content: [{ type: "text", text: `Stopped media task ${params.task_id}` }],
                details: manager.status(params.task_id),
            };
        },
    });

    const mediaStatus = defineTool({
        name: "media_status",
        label: "Media Status",
        description: "Inspect one background media task or all media tasks.",
        parameters: Type.Object({
            task_id: Type.Optional(Type.String({ description: "Media task ID; omit to list all tasks" })),
        }),
        async execute(_toolCallId, params) {
            const status = params.task_id ? manager.status(params.task_id) : manager.list();
            return {
                content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
                details: status,
            };
        },
    });

    return [playMedia, stopMedia, mediaStatus];
}
