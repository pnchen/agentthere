import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const state = {
    client: null,
  };

  const createClient = () => {
    const handlers = new Map();
    return {
      subscribe: vi.fn(),
      publish: vi.fn(),
      end: vi.fn(),
      on: vi.fn((event, handler) => {
        handlers.set(event, handler);
      }),
      emit(event, ...args) {
        const handler = handlers.get(event);
        return handler?.(...args);
      },
    };
  };

  return {
    state,
    mockConnect: vi.fn(() => {
      state.client = createClient();
      return state.client;
    }),
    mockCreatePeer: vi.fn(async () => ({ close: vi.fn() })),
    mockGetSessionByPeerId: vi.fn(() => null),
    mockSendToPeer: vi.fn(() => true),
    mockRegisterIncomingFile: vi.fn(),
    mockHandleIncomingChunk: vi.fn(() => null),
  };
});

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => "12345678-1234-1234-1234-1234567890ab",
  };
});

vi.mock("mqtt", () => ({
  connect: mocks.mockConnect,
}));

vi.mock("./channel/rtc/peer.js", () => ({
  createPeer: mocks.mockCreatePeer,
}));

vi.mock("./channel/sessions.js", () => ({
  getSessionByPeerId: mocks.mockGetSessionByPeerId,
  sendToPeer: mocks.mockSendToPeer,
  registerSession: vi.fn(),
  removeSession: vi.fn(),
}));

let startGroupMonitor;

describe("AgentThere rtc monitor invite topics", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.state.client = null;
    ({ startGroupMonitor } = await import("./channel/rtc"));
  });

  it("subscribes to the shared invite topic on connect", async () => {
    const { cleanup } = await startGroupMonitor({
      mqtt: { url: "mqtt://broker.example" },
      groupId: "alpha",
      agentId: "agent-1",
      iceServers: [],
      onMessage: vi.fn(),
      agentName: "AgentThere Bot",
    });

    const client = mocks.state.client;
    client.emit("connect");

    expect(client.subscribe).toHaveBeenCalledWith("alpha/serve");
    expect(client.subscribe).toHaveBeenCalledWith("agent-1/invite");

    cleanup();
  });

  it("only accepts invites whose payload group matches the monitor group", async () => {
    const { cleanup } = await startGroupMonitor({
      mqtt: { url: "mqtt://broker.example" },
      groupId: "alpha",
      agentId: "agent-1",
      iceServers: [],
      onMessage: vi.fn(),
      agentName: "AgentThere Bot",
    });

    const client = mocks.state.client;

    client.emit(
      "message",
      "agent-1/invite",
      Buffer.from(JSON.stringify({ id: "peer-beta", profile: { name: "Beta" }, group: "beta" })),
    );
    await Promise.resolve();

    expect(mocks.mockCreatePeer).not.toHaveBeenCalled();

    client.emit(
      "message",
      "agent-1/invite",
      Buffer.from(JSON.stringify({ id: "peer-alpha", profile: { name: "Alpha" }, group: "alpha" })),
    );
    await Promise.resolve();

    expect(mocks.mockCreatePeer).toHaveBeenCalledTimes(1);
    expect(mocks.mockCreatePeer).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.any(String),
        iceServers: [],
        initiateOffer: true,
      }),
    );

    cleanup();
  });
});
