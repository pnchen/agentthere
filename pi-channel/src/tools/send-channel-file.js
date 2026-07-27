/**
 * send_channel_file — custom tool for both Pi extension and Pi SDK modes.
 *
 * Allows the LLM to send a file to AgentThere channel peers over WebRTC.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import { sendMedia } from "../file-transfer.js";
export function createSendChannelFileTool(deps) {
    console.log(`[pi-channel/file-tool] registering send_channel_file groups=${JSON.stringify(deps.getGroupIds())}`);
    return defineTool({
        name: "send_channel_file",
        label: "Send Channel File",
        description: "Send a file from the local filesystem (absolute path or relative to the working directory) or an HTTP(S) URL to AgentThere channel participants.",
        parameters: Type.Object({
            path: Type.String({
                description: "Absolute file path or HTTP(S) URL of the file to send",
            }),
            group_id: Type.Optional(Type.String({
                description: "Target AgentThere group ID. Defaults to the first active channel group.",
            })),
        }),
        async execute(toolCallId, params, _signal, _onUpdate, ctx) {
            console.log(`[pi-channel/file-tool] execute toolCallId=${toolCallId} params=${JSON.stringify(params)}`);
            const groupId = params.group_id ?? deps.getGroupIds()[0];
            if (!groupId) {
                throw new Error("No active AgentThere channel group");
            }
            const rawPath = params.path;
            const isUrl = /^https?:\/\//i.test(rawPath);
            const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd();
            const resolvedPath = isUrl
                ? rawPath
                : path.isAbsolute(rawPath)
                    ? rawPath
                    : path.resolve(cwd, rawPath);
            console.log(`[pi-channel/file-tool] resolved group=${groupId} path=${resolvedPath} isUrl=${isUrl}`);
            const agentProfile = deps.getAgentProfile();
            const result = await sendMedia({
                rawUrl: resolvedPath,
                groupId,
                agentProfile,
            });
            console.log(`[pi-channel/file-tool] result=${JSON.stringify(result)}`);
            if (!result.ok) {
                throw new Error(`Failed to send file to group "${groupId}": no connected peers or transfer incomplete`);
            }
            return {
                content: [
                    {
                        type: "text",
                        text: `Sent file to group "${groupId}" (message ${result.messageId})`,
                    },
                ],
                details: {
                    messageId: result.messageId,
                    objectId: result.objectId,
                },
            };
        },
    });
}
