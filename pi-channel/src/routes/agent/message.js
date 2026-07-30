import express from "express";
import { intentDetection } from "./middleware/intent-detection.js";
import { historyContext } from "./middleware/history-context.js";
import { authGate } from "./middleware/auth-gate/index.js";

const router = express.Router();

router.use((req, res, next) => {
    const body = req.body || {};
    const message = body.message && typeof body.message === "object"
        ? body.message
        : body.text != null
            ? { type: "text", text: String(body.text) }
            : null;
    if (!message || !["text", "file"].includes(message.type)) {
        return res.status(400).json({ accepted: false, error: "message is required" });
    }
    if (message.type === "text") {
        const text = String(message.text).trim();
        if (!text) return res.status(400).json({ accepted: false, error: "text message is required" });
        req.$message = { type: "text", text };
    }
    else {
        req.$message = {
            type: "file",
            name: String(message.name || "file"),
            path: String(message.path || ""),
        };
    }
    next();
});

router.use(intentDetection);
router.use(historyContext);
router.use(authGate);

router.post("/", async (req, res, next) => {
    try {
        const session = req.$agent_session.session;
        const promptText = req.$getCombinedBody(req.$message);
        if (session.isStreaming) {
            await session.steer(promptText);
        }
        else {
            await session.prompt(promptText);
        }
        return res.status(202).json({ accepted: true });
    }
    catch (error) {
        return next(error);
    }
});

export default router;
