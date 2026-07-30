import express from "express";
import messageRouter from "./message.js";
import callRouter from "./call/index.js";
import commandRouter from "./command.js";
import { agentContext } from "./agent-context.js";

const router = express.Router();

router.use("/", agentContext);
router.use("/message", messageRouter);
router.use("/call", callRouter);
router.use("/command", commandRouter);

export default router;
