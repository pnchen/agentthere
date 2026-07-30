/** Message ID generation for AgentThere protocol messages. */
import { randomUUID } from "node:crypto";

export function createMessageId() {
    const suffix = randomUUID().replace(/-/g, "").slice(0, 8);
    return `agentthere-${Date.now()}-${suffix}`;
}
