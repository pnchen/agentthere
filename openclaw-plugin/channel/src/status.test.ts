import { describe, expect, it } from "vitest";
import { agenttherePlugin } from "./plugin.js";

describe("agentthere status adapter", () => {
  it("builds an account snapshot from AgentThere config and probe data", async () => {
    const status = agenttherePlugin.status;
    if (!status?.buildAccountSnapshot) {
      throw new Error("AgentThere plugin did not expose a status adapter");
    }

    const snapshot = await status.buildAccountSnapshot({
      account: {
        accountId: "default",
        agentName: "AgentThere Bot",
        enabled: true,
        mqtt: { url: "mqtt://broker.example" },
        dmPolicy: "pairing",
        groupIds: ["hello", "test"],
      },
      cfg: {},
      runtime: status.defaultRuntime,
      probe: {
        ok: true,
        signaling: {
          configured: true,
          url: "mqtt://broker.example",
        },
        activeSessions: 2,
      },
    });

    expect(snapshot).toMatchObject({
      accountId: "default",
      name: "AgentThere Bot",
      enabled: true,
      configured: true,
      signalingConfigured: true,
      signalingUrl: "mqtt://broker.example",
      activeSessions: 2,
      groupCount: 2,
      dmPolicy: "pairing",
      groups: ["hello", "test"],
    });
  });

  it("collects a config issue when signaling is missing on an enabled account", () => {
    const status = agenttherePlugin.status;
    if (!status?.collectStatusIssues) {
      throw new Error("AgentThere plugin did not expose status issue collection");
    }

    expect(
      status.collectStatusIssues([
        {
          accountId: "default",
          enabled: true,
          signalingConfigured: false,
        },
      ]),
    ).toEqual([
      {
        channel: "agentthere",
        accountId: "default",
        kind: "config",
        message: "MQTT signaling URL missing",
        fix: "Set channels.agentthere.mqtt.url or rerun the AgentThere setup flow.",
      },
    ]);
  });
});
