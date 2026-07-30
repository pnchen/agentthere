/**
 * AgentThere Group Media-Task API.
 *
 * All requests except the route documentation require:
 *   X-AgentThere-Group-Id: <group_id>
 *
 * POST /group/media-task/play
 *   Start media playback for the specified Group.
 *   Body: { source: string, loop?: boolean }
 *   Returns: { accepted: boolean, task_id: string, details: TaskStatus }
 *
 * POST /group/media-task/:task_id/stop
 *   Stop a media task and close its media peers.
 *   Params: task_id: string
 *   Returns: { accepted: boolean, task_id: string, details: TaskStatus }
 *
 * POST /group/media-task/:task_id/pause
 *   Pause a playing media task without removing its media peers.
 *   Params: task_id: string
 *   Returns: { accepted: boolean, task_id: string, position: number }
 *
 * POST /group/media-task/:task_id/resume
 *   Resume a paused media task.
 *   Params: task_id: string
 *   Returns: { accepted: boolean, task_id: string }
 *
 * POST /group/media-task/:task_id/seek
 *   Seek to a position in seconds. The position is clamped to the media duration.
 *   Params: task_id: string
 *   Body: { position: number }
 *   Returns: { accepted: boolean, task_id: string, position: number }
 *
 * GET /group/media-task/status
 *   List all media tasks belonging to the specified Group.
 *   Returns: TaskStatus[]
 *
 * GET /group/media-task/:task_id/status
 *   Get the status of one media task.
 *   Params: task_id: string
 *   Returns: TaskStatus
 *
 * TaskStatus:
 *   taskId: string
 *   source: string
 *   groupId: string
 *   state: "created" | "starting" | "playing" | "paused" | "completed" | "failed" | "stopped"
 *   mediaKind: "video" | "audio" | "av" | null
 *   videoCodec: string | null
 *   width: number
 *   height: number
 *   bitRate: number
 *   duration: number
 *   position: number
 *   error: string | null
 *   startedAt: number | null
 */

import express from "express";
import { getGroup } from "../../rtc/index.js";

const router = express.Router();
const GROUP_HEADER = "X-AgentThere-Group-Id";

// ── middleware ──────────────────────────────────────────────────────────

router.use((req, res, next) => {
    if (req.method === "GET" && req.path === "/") return next();
    try {
        const groupId = req.get(GROUP_HEADER);
        if (!groupId) return res.status(400).json({ error: "X-AgentThere-Group-Id header is required" });
        const group = getGroup(groupId);
        if (!group) return res.status(404).json({ error: `Group not found: ${groupId}` });
        req.$manager = group.mediaTaskManager;
        if (!req.$manager) return res.status(500).json({ error: "Group media task manager is not available" });
        next();
    }
    catch (error) {
        next(error);
    }
});

// ── root routes ─────────────────────────────────────────────────────────

router.post("/play", async (req, res) => {
    try {
        const { source, loop } = req.body || {};
        if (!source) return res.status(400).json({ error: "source is required" });
        const task = await req.$manager.start({
            source,
            groupId: req.get(GROUP_HEADER),
            loop: !!loop,
        });
        return res.json({ accepted: true, task_id: task.taskId, details: task.status() });
    }
    catch (error) {
        return res.status(500).json({ accepted: false, error: error?.message || String(error) });
    }
});

router.get("/status", (req, res) => {
    return res.json(req.$manager.list());
});

// ── task routes (URL carries taskId) ────────────────────────────────────

router.use("/:task_id", (req, res, next) => {
    const { task_id } = req.params;
    if (!task_id) return res.status(400).json({ error: "task_id is required in URL" });
    const status = req.$manager.status(task_id);
    if (!status) return res.status(404).json({ error: `task not found: ${task_id}` });
    req.$task = status;
    next();
});

router.post("/:task_id/stop", (req, res) => {
    req.$manager.stop(req.$task.taskId);
    return res.json({ accepted: true, task_id: req.$task.taskId, details: req.$task });
});

router.post("/:task_id/pause", (req, res) => {
    if (!req.$manager.pause(req.$task.taskId)) {
        return res.status(400).json({ error: `cannot pause task in state: ${req.$task.state}` });
    }
    return res.json({ accepted: true, task_id: req.$task.taskId, position: req.$task.position });
});

router.post("/:task_id/resume", (req, res) => {
    if (req.$task.state !== "paused") {
        return res.status(400).json({ error: `task is not paused (state: ${req.$task.state})` });
    }
    req.$manager.resume(req.$task.taskId);
    return res.status(202).json({ accepted: true, task_id: req.$task.taskId });
});

router.post("/:task_id/seek", (req, res) => {
    const pos = parseFloat(req.body?.position);
    if (isNaN(pos) || pos < 0) return res.status(400).json({ error: "position must be a non-negative number" });
    req.$manager.seek(req.$task.taskId, pos);
    return res.status(202).json({ accepted: true, task_id: req.$task.taskId, position: pos });
});

router.get("/:task_id/status", (req, res) => {
    return res.json(req.$task);
});

export default router;
