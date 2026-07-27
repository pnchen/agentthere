/**
 * Text/file message terminal handler.
 *
 * The route receives a generic ctx.message. History has already attached a
 * lazy ctx.getCombinedBody() function; this handler converts the facts into
 * the final prompt string only now.
 */

export async function messageHandler(ctx) {
    const { session, peerName, peerId, agentName, getCombinedBody, isCommand = false } = ctx;
    const message = ctx.message;
    if (!message) return;

    const body = getCombinedBody?.(message) ?? describeMessage(message);
    const promptText = isCommand
        ? String(message.text ?? "").trim()
        : addIdentityHint(body, agentName);

    console.log(`[agentthere:recv] from=${peerName} peerId=${peerId} type=${message.type}`);

    try {
        if (isCommand) {
            await session.prompt(promptText, {
                ...(session.isStreaming ? { streamingBehavior: "steer" } : {}),
            });
        }
        else if (session.isStreaming) {
            await session.steer(promptText);
        }
        else {
            await session.prompt(promptText);
        }
    }
    catch (err) {
        console.error(`[agentthere:dispatch] failed: ${String(err)}`);
    }
}

function addIdentityHint(body, agentName) {
    const identityHint = agentName
        ? `In this AgentThere group, your display identity is "${agentName}". Use this name when referring to yourself.`
        : "";
    return identityHint ? `${identityHint}\n\n${body}` : body;
}

function describeMessage(message) {
    if (message?.type === "text") return String(message.text ?? "").trim();
    if (message?.type === "file") {
        const name = String(message.name ?? "file");
        const filePath = String(message.path ?? "");
        return filePath
            ? `用户发来了一个文件，文件名是 "${name}"，文件路径是：${filePath}`
            : `用户发来了一个文件，文件名是 "${name}"`;
    }
    return "";
}
