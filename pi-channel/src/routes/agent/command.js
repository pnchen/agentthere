import express from "express";
import { historyContext } from "./middleware/history-context.js";
import { authGate } from "./middleware/auth-gate/index.js";
import { getAgentSessionForGroup } from "../../agent.js";

const router = express.Router();

router.use((req, res, next) => {
    if (req.method === "GET") return next();
    const body = req.body || {};
    const command = body.command ?? body.text ?? body.message?.text;
    if (command == null || !String(command).trim()) {
        return res.status(400).json({ accepted: false, error: "command is required" });
    }
    req.$message = { type: "text", text: String(command).trim() };
    req.$mentioned = true;
    next();
});

function normalizeCommandName(name) {
    return String(name || "").replace(/^\//, "");
}

function getSessionCommands(session, resourceLoader) {
    const extensionCommands = session.extensionRunner?.getRegisteredCommands?.() ?? [];
    const promptTemplates = session.promptTemplates ?? [];
    const skills = resourceLoader?.getSkills?.().skills ?? [];

    return [
        ...extensionCommands.map((command) => ({
            name: normalizeCommandName(command.invocationName),
            description: command.description,
            source: "extension",
        })),
        ...promptTemplates.map((template) => ({
            name: normalizeCommandName(template.name),
            description: template.description,
            source: "prompt",
        })),
        ...skills.map((skill) => ({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: "skill",
        })),
    ];
}

function commandList(session, resourceLoader) {
    return [
        {
            name: "compact",
            description: "Compact the current session context",
            source: "agent",
        },
        {
            name: "cancel",
            description: "Abort the current agent loop",
            source: "agent",
        },
        ...getSessionCommands(session, resourceLoader).map((command) => ({
            name: command.name,
            description: command.description,
            source: command.source,
        })),
    ];
}

router.get("/", async (req, res, next) => {
    try {
        const groupId = req.get("X-AgentThere-Group-Id");
        if (!groupId) return res.status(400).json({ error: "group is required" });

        const created = await getAgentSessionForGroup(groupId);
        if (!created?.session) {
            return res.status(404).json({ error: `Group not found: ${groupId}` });
        }
        return res.json(commandList(created.session, created.resourceLoader));
    }
    catch (error) {
        return next(error);
    }
});

router.use(historyContext);
router.use(authGate);

router.post("/", async (req, res, next) => {
    try {
        const commandText = String(req.$message.text ?? "").trim();
        const session = req.$agent_session.session;
        if (commandText === "/compact") {
            await session.compact();
        }
        else if (commandText === "/cancel") {
            session.abort();
        }
        else {
            await session.sendUserMessage(
                commandText,
                session.isStreaming ? { deliverAs: "steer" } : undefined,
            );
        }
        return res.status(202).json({ accepted: true });
    }
    catch (error) {
        req.$peer.send(JSON.stringify({
            type: "system",
            text: `[AgentThere] Command failed: ${error?.message || String(error)}`,
        }));
        return next(error);
    }
});

export default router;
