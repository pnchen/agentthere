import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockSendToPeer,
  mockListSessions,
  mockGetSessionByPeerId,
  mockStatSync,
  mockReadFileSync,
} = vi.hoisted(() => ({
  mockSendToPeer: vi.fn(() => true),
  mockListSessions: vi.fn(),
  mockGetSessionByPeerId: vi.fn(),
  mockStatSync: vi.fn(),
  mockReadFileSync: vi.fn(),
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
    readFileSync: mockReadFileSync,
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  },
}));

vi.mock("./channel/sessions.js", () => ({
  sendToPeer: mockSendToPeer,
  listSessions: mockListSessions,
  getSessionByPeerId: mockGetSessionByPeerId,
}));

import { sendFileToGroup } from "./channel/file-send.js";

describe("AgentThere file transfer metadata mapping", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const dc = {
      isOpen: () => true,
      bufferedAmount: () => 0,
      setBufferedAmountLowThreshold: vi.fn(),
      onBufferedAmountLow: vi.fn(),
    };

    mockListSessions.mockReturnValue([
      {
        sessionMode: "group",
        groupId: "alpha",
        peerId: "peer-1",
        connected: true,
        dc,
      },
    ]);
    mockGetSessionByPeerId.mockReturnValue({ dc });
    mockStatSync.mockReturnValue({ size: 4 });
    mockReadFileSync.mockReturnValue(Buffer.from("ping"));
  });

  it("sends file metadata without a room field", async () => {
    const result = await sendFileToGroup({
      filePath: "/tmp/demo.txt",
      fileName: "demo.txt",
      mimeType: "text/plain",
      groupId: "alpha",
      agentProfile: { name: "AgentThere Bot", agent: true },
    });

    expect(result).toMatchObject({
      ok: true,
      messageId: expect.stringMatching(/^agentthere-/),
      objectId: "1234567812341234",
    });
    expect(mockSendToPeer).toHaveBeenCalled();

    const metadataPayload = JSON.parse(mockSendToPeer.mock.calls[0][1]);
    expect(metadataPayload).toMatchObject({
      id: expect.stringMatching(/^agentthere-/),
      file: { name: "demo.txt", size: 4, type: "text/plain" },
      object_id: "1234567812341234",
      from: { name: "AgentThere Bot", agent: true },
    });
    expect(metadataPayload).not.toHaveProperty("room");
    expect(metadataPayload).not.toHaveProperty("groupId");
  });
});
