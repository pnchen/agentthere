import { describe, expect, it, vi } from "vitest";

vi.mock("node:crypto", () => ({
  randomUUID: () => "12345678-1234-1234-1234-1234567890ab",
}));

import { buildOutboundTextMessage } from "./channel/messaging.js";

describe("AgentThere outbound text payloads", () => {
  it("builds a final-form text message with a stable id and agent profile", () => {
    const message = buildOutboundTextMessage({
      text: "hello",
      agentProfile: { name: "AgentThere Bot", agent: true, avatar: "https://example.com/a.png" },
    });

    expect(message).toEqual({
      id: expect.stringMatching(/^agentthere-/),
      text: "hello",
      from: {
        name: "AgentThere Bot",
        agent: true,
        avatar: "https://example.com/a.png",
      },
    });
  });
});
