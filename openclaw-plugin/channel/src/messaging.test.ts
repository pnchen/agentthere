import { describe, expect, it } from "vitest";
import {
  formatTargetDisplay,
  looksLikeTargetId,
  normalizeMessagingTarget,
  parseMessagingTarget,
  resolveOutboundSessionRoute,
} from "./channel/messaging.js";

describe("AgentThere messaging target normalization", () => {
  it("normalizes direct-peer target forms", () => {
    expect(normalizeMessagingTarget("peer:E123")).toBe("peer:E123");
    expect(normalizeMessagingTarget("agentthere:user:E123")).toBe("peer:E123");
    expect(normalizeMessagingTarget("@E123")).toBe("peer:E123");
    expect(normalizeMessagingTarget("E123")).toBe("peer:E123");
  });

  it("normalizes group target forms", () => {
    expect(normalizeMessagingTarget("agentthere:group:test")).toBe("group:test");
    expect(normalizeMessagingTarget("group:test")).toBe("group:test");
    expect(normalizeMessagingTarget("#test")).toBe("group:test");
  });

  it("rejects empty and whitespace targets", () => {
    expect(normalizeMessagingTarget("   ")).toBeUndefined();
    expect(normalizeMessagingTarget("peer:   ")).toBeUndefined();
  });

  it("rejects unsupported prefixed targets", () => {
    expect(normalizeMessagingTarget("legacy:test")).toBeUndefined();
    expect(normalizeMessagingTarget("agentthere:legacy:test")).toBeUndefined();
  });

  it("recognizes supported target ids", () => {
    expect(looksLikeTargetId("group:test")).toBe(true);
    expect(looksLikeTargetId("@E123")).toBe(true);
    expect(looksLikeTargetId("hello world")).toBe(false);
  });
});

describe("AgentThere messaging target display and routing", () => {
  it("formats group and peer targets for display", () => {
    expect(formatTargetDisplay({ target: "group:test" })).toBe("#test");
    expect(formatTargetDisplay({ target: "peer:E123" })).toBe("@E123");
    expect(formatTargetDisplay({ target: "peer:E123", display: "Control Group" })).toBe(
      "Control Group",
    );
  });

  it("parses normalized targets into routing kinds", () => {
    expect(parseMessagingTarget("group:test")).toEqual({
      kind: "group",
      id: "test",
      normalized: "group:test",
    });
    expect(parseMessagingTarget("peer:E123")).toEqual({
      kind: "direct",
      id: "E123",
      normalized: "peer:E123",
    });
  });

  it("builds outbound session routes for group and peer targets", () => {
    expect(
      resolveOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "default",
        target: "group:test",
      }),
    ).toEqual({
      sessionKey: "agentthere:group:test",
      baseSessionKey: "agentthere:group:test",
      peer: { kind: "group", id: "test" },
      chatType: "group",
      from: "default",
      to: "agentthere:group:test",
    });

    expect(
      resolveOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "default",
        target: "peer:E123",
      }),
    ).toEqual({
      sessionKey: "agentthere:default:E123",
      baseSessionKey: "agentthere:default:E123",
      peer: { kind: "direct", id: "E123" },
      chatType: "direct",
      from: "default",
      to: "E123",
    });
  });
});
