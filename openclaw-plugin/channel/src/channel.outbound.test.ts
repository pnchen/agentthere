import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSendToPeer,
  mockGetSessionByPeerId,
  mockListSessions,
  mockSendFileToPeer,
  mockSendFileToGroup,
  mockStatSync,
} = vi.hoisted(() => ({
  mockSendToPeer: vi.fn(() => true),
  mockGetSessionByPeerId: vi.fn(() => undefined),
  mockListSessions: vi.fn(() => []),
  mockSendFileToPeer: vi.fn(),
  mockSendFileToGroup: vi.fn(),
  mockStatSync: vi.fn(() => ({ size: 4 })),
}));

vi.mock("node:crypto", () => ({
  randomUUID: () => "12345678-1234-1234-1234-1234567890ab",
}));

vi.mock("node:fs", () => ({
  default: {
    constants: { W_OK: 2, X_OK: 1 },
    accessSync: vi.fn(),
    chmodSync: vi.fn(),
    lstatSync: vi.fn(() => ({ isDirectory: () => true, isSymbolicLink: () => false, mode: 0o700, uid: process.getuid?.() ?? 501 })),
    statSync: mockStatSync,
    readFileSync: vi.fn(),
    existsSync: vi.fn(() => false),
  },
}));

vi.mock("./channel/sessions.js", () => ({
  sendToPeer: mockSendToPeer,
  getSessionByPeerId: mockGetSessionByPeerId,
  listSessions: mockListSessions,
}));

vi.mock("./channel/file-send.js", () => ({
  sendFileToPeer: mockSendFileToPeer,
  sendFileToGroup: mockSendFileToGroup,
  sendMedia: vi.fn(async (params) => {
    if (params.groupId) return mockSendFileToGroup(params);
    return mockSendFileToPeer(params);
  }),
  resolveMimeType: vi.fn(() => "application/octet-stream"),
}));

vi.mock("./channel/rtc", () => ({
  startGroupMonitor: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getRuntime: () => ({
    error: vi.fn(),
    channel: {
      session: {
        resolveStorePath: vi.fn(),
      },
    },
  }),
}));

vi.mock("./config.js", () => ({
  DEFAULT_ACCOUNT_ID: "default",
  listAccountIds: vi.fn(() => ["default"]),
  resolveAgentIdentityForGroup: vi.fn((cfg, groupId) => ({
    agentName: `Agent ${groupId}`,
    agentAvatar: `https://example.com/${groupId}.png`,
  })),
  resolveAccount: vi.fn(() => ({
    accountId: "default",
    enabled: true,
    configured: true,
    mqtt: { url: "mqtt://broker.example" },
  })),
  resolveGroupOpenClawAgentId: vi.fn(),
  resolveGroupSkillFilter: vi.fn(),
  resolveGroupSystemPrompt: vi.fn(),
}));

import { agenttherePlugin } from "./plugin.js";

describe("AgentThere outbound payload integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendToPeer.mockReturnValue(true);
    mockGetSessionByPeerId.mockReturnValue(undefined);
    mockListSessions.mockReturnValue([]);
    mockSendFileToPeer.mockResolvedValue({ ok: true, messageId: "agentthere-file-msg-1", objectId: "obj-1" });
    mockSendFileToGroup.mockResolvedValue({ ok: true, messageId: "agentthere-file-msg-2", objectId: "obj-2" });
    mockStatSync.mockReturnValue({ size: 4 });
  });

  it("sendText emits a final-form direct message with id instead of legacy reply type", async () => {
    const sendText = agenttherePlugin.outbound?.sendText;
    if (!sendText) {
      throw new Error("agentthere outbound.sendText unavailable");
    }

    const result = await sendText({
      cfg: {},
      to: "peer:E123",
      text: "hello",
      accountId: "default",
    } as never);

    expect(result).toEqual({
      channel: "agentthere",
      messageId: expect.stringMatching(/^agentthere-/),
      ok: true,
    });

    expect(mockSendToPeer).toHaveBeenCalledTimes(1);
    expect(mockSendToPeer).toHaveBeenCalledWith(
      "E123",
      expect.any(String),
    );

    const payload = JSON.parse(mockSendToPeer.mock.calls[0][1]);
    expect(payload).toEqual({
      id: result.messageId,
      text: "hello",
      from: {
        name: "OpenClaw Agent",
        agent: true,
      },
    });
    expect(payload).not.toHaveProperty("type");
  });

  it("sendMedia keeps file delivery and caption text on the same final-form text shape", async () => {
    const sendMedia = agenttherePlugin.outbound?.sendMedia;
    if (!sendMedia) {
      throw new Error("agentthere outbound.sendMedia unavailable");
    }

    const result = await sendMedia({
      cfg: {},
      to: "peer:E123",
      text: "caption text",
      mediaUrl: "/tmp/demo.txt",
      accountId: "default",
    } as never);

    expect(mockSendFileToPeer).toHaveBeenCalledWith(expect.objectContaining({
      peerId: "E123",
      rawUrl: "/tmp/demo.txt",
      agentProfile: {
        name: "OpenClaw Agent",
        agent: true,
      },
    }));

    expect(mockSendToPeer).toHaveBeenCalledTimes(1);
    const captionPayload = JSON.parse(mockSendToPeer.mock.calls[0][1]);
    expect(captionPayload).toEqual({
      id: expect.stringMatching(/^agentthere-/),
      text: "caption text",
      from: {
        name: "OpenClaw Agent",
        agent: true,
      },
    });
    expect(captionPayload).not.toHaveProperty("type");

    expect(result).toEqual({
      channel: "agentthere",
      messageId: "agentthere-file-msg-1",
      ok: true,
    });
  });
});
