/**
 * AgentThere Group Session API.
 *
 * All requests require:
 *   X-AgentThere-Group-Id: <group_id>
 *
 * GET /group/session
 *   List persisted sessions belonging to the Group's Agent.
 *
 * POST /group/session/new
 *   Create and load a new session for the Group.
 *
 * POST /group/session/:session_id/switch
 *   Switch the Group to an existing session.
 */

import express from "express";
import fs from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { getGroup } from "../../rtc/index.js";
import { getConfig, resolveAgentWorkspaceDir } from "../../config.js";
import { getCurrentAgentSessionForGroup, requestNewAgentSessionForGroup, requestSwitchAgentSessionForGroup } from "../../agent.js";

const router = express.Router();
const GROUP_HEADER = "X-AgentThere-Group-Id";

router.use((req, res, next) => {
    const groupId = req.get(GROUP_HEADER);
    if (!groupId) return res.status(400).json({ error: `${GROUP_HEADER} header is required` });
    const group = getGroup(groupId);
    if (!group) return res.status(404).json({ error: `Group not found: ${groupId}` });
    req.$group = group;
    req.$groupId = groupId;
    next();
});

router.get("/", async (req, res, next) => {
    try {
        const agentName = req.$group.agentName;
        const workspaceDir = resolveAgentWorkspaceDir(getConfig(), agentName);
        const loadedFile = await getCurrentAgentSessionForGroup(req.$groupId);
        const sessions = await listSessions(workspaceDir, agentName, req.$groupId);
        return res.json(sessions.map((session) => ({
            id: session.id,
            path: session.path,
            name: session.name,
            created: session.created,
            modified: session.modified,
            messageCount: session.messageCount,
            current: session.path === loadedFile,
        })));
    }
    catch (error) {
        return next(error);
    }
});

router.post("/new", (req, res, next) => {
    try {
        requestNewAgentSessionForGroup(req.$groupId);
        return res.status(202).json({
            accepted: true,
            status: "scheduled",
            message: "A new session will be loaded before the next user message.",
        });
    }
    catch (error) {
        return next(error);
    }
});

router.post("/:session_id/switch", async (req, res, next) => {
    try {
        await requestSwitchAgentSessionForGroup(req.$groupId, req.params.session_id);
        return res.status(202).json({
            accepted: true,
            status: "scheduled",
            session_id: req.params.session_id,
            message: "The selected session will be loaded before the next user message.",
        });
    }
    catch (error) {
        return next(error);
    }
});

async function listSessions(workspaceDir, agentName, groupId) {
    const sessions = await SessionManager.list(workspaceDir);
    return sessions
        .map((session) => ({ ...session, metadata: readMetadata(session.path) }))
        .filter((session) => session.metadata?.agent_name === agentName && session.metadata?.group_id === groupId)
        .sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

function readMetadata(sessionFile) {
    try {
        let metadata = null;
        for (const line of fs.readFileSync(sessionFile, "utf8").split("\n")) {
            if (!line.trim()) continue;
            let entry;
            try { entry = JSON.parse(line); } catch { continue; }
            if (entry.type === "custom" && entry.customType === "agentthere.session") metadata = entry.data;
        }
        return metadata;
    }
    catch {
        return null;
    }
}

export default router;
