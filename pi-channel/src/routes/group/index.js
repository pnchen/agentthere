import express from "express";
import mediaTaskRouter from "./media-task.js";
import sessionRouter from "./session.js";

const router = express.Router();

router.use("/media-task", mediaTaskRouter);
router.use("/session", sessionRouter);

export default router;
