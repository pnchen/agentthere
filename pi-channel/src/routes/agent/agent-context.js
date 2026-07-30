import { getAgentSessionForGroup } from "../../agent.js";
import { getGroup, getPeer } from "../../rtc/index.js";

const GROUP_HEADER = "X-AgentThere-Group-Id";
const PEER_HEADER = "X-AgentThere-Peer-Id";

export async function agentContext(req, res, next) {
    try {
        if (req.method === "GET") return next();
        const groupId = req.get(GROUP_HEADER);
        const peerId = req.get(PEER_HEADER);
        if (!groupId) return res.status(400).json({ accepted: false, error: "group is required" });
        if (!peerId) return res.status(400).json({ accepted: false, error: "peer is required" });

        const group = getGroup(groupId);
        if (!group) return res.status(404).json({ accepted: false, error: `Group not found: ${groupId}` });

        const peer = getPeer(groupId, peerId);
        if (!peer) return res.status(404).json({ accepted: false, error: "peer not found" });

        req.$group = group;
        req.$peer = peer;

        req.$agent_session = await getAgentSessionForGroup(groupId);
        if (!req.$agent_session?.output) {
            return res.status(404).json({ accepted: false, error: `Group not found: ${groupId}` });
        }

        return next();
    }
    catch (error) {
        return next(error);
    }
}

export { GROUP_HEADER, PEER_HEADER };
