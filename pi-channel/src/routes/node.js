import express from "express";
import { getPeers } from "../rtc/index.js";
import {
  RpcRemoteError,
  RpcTimeoutError,
  RpcTransportError,
} from "../rtc/peer/rpc.js";

const router = express.Router();

function errorResponse(res, status, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return res.status(status).json({ error });
}

function rpcErrorStatus(error) {
  if (error instanceof RpcTimeoutError || error?.code === "RPC_TIMEOUT")
    return 504;
  if (
    error instanceof RpcTransportError ||
    error?.code === "RPC_TRANSPORT_ERROR"
  )
    return 502;
  if (error instanceof RpcRemoteError || error?.rpc === true) {
    if (error.code === -32600 || error.code === -32602) return 400;
    if (error.code === -32601) return 404;
    if (error.code === -32603) return 502;
    return 422;
  }
  return 500;
}

// POST /node — invoke a method on a node.
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const group = req.get("X-AgentThere-Group-Id");
    const userName = body.user;
    const method = body.method;
    const params = body.params ?? {};

    if (typeof group !== "string" || !group) {
      return errorResponse(
        res,
        400,
        "HTTP_INVALID_REQUEST",
        "group is required",
      );
    }
    if (typeof userName !== "string" || !userName.trim()) {
      return errorResponse(
        res,
        400,
        "HTTP_INVALID_REQUEST",
        "user is required",
      );
    }
    if (typeof method !== "string" || !method.trim()) {
      return errorResponse(
        res,
        400,
        "HTTP_INVALID_REQUEST",
        "method is required",
      );
    }

    const target = userName.trim().toLowerCase();
    const peers = getPeers();
    const matches = [...peers.values()].filter(
      (peer) =>
        peer.groupId === group &&
        String(peer.peerName || "")
          .trim()
          .toLowerCase() === target,
    );

    if (matches.length === 0) {
      return errorResponse(
        res,
        404,
        "PEER_NOT_FOUND",
        `User not found: ${userName}`,
      );
    }
    if (matches.length > 1) {
      return errorResponse(
        res,
        409,
        "PEER_AMBIGUOUS",
        `Multiple users match: ${userName}`,
      );
    }

    const peer = matches[0];
    console.log(`[pi-channel/http] → ${peer.peerName} rpc: ${method}`);
    const result = await peer.rpc.call(method, params);
    console.log(`[pi-channel/http] ← ${peer.peerName} rpc: ${method} ok`);
    return res.json({ from: peer.peerName, method, result });
  } catch (error) {
    const status = rpcErrorStatus(error);
    console.warn(
      `[pi-channel/http] node call failed: ${error?.message || error}`,
    );
    return errorResponse(
      res,
      status,
      error?.code ?? "HTTP_INTERNAL_ERROR",
      error?.message || "Device call failed",
      error?.data,
    );
  }
});

export default router;
