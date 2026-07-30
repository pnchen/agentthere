/**
 * Pi Channel Service — process entrypoint and local HTTP server.
 *
 * Agent/Group/Session runtime is started by task/index.js. Express remains
 * owned and configured here.
 */
import express from "express";
import http from "node:http";
import nodeRouter from "./src/routes/node.js";
import agentRouter from "./src/routes/agent/index.js";
import groupRouter from "./src/routes/group/index.js";
import "./task/index.js";

// ── HTTP RPC server (localhost only) ──
const app = express();
app.use(express.json());

app.use("/node", nodeRouter);
app.use("/agent", agentRouter);
app.use("/group", groupRouter);

app.use((error, req, res, _next) => {
  if (res.headersSent) return;
  console.error(
    `[pi-channel:http] ${req.method} ${req.originalUrl} failed: ${String(error)}`,
  );
  res.status(error?.statusCode || error?.status || 500).json({
    accepted: false,
    error: error?.code || "HTTP_INTERNAL_ERROR",
    message: error?.message || "Internal server error",
  });
});

const HTTP_PORT = 9001;
const server = http.createServer(app);
server.listen(HTTP_PORT, "127.0.0.1", () => {
  console.log(`[pi-channel:http] listening on http://127.0.0.1:${HTTP_PORT}`);
});
