/**
 * AgentThere Agent task.
 *
 * Importing this module starts Agent configuration synchronization. The Agent
 * objects and Session access API live in src/agent.js; this module only owns
 * task lifecycle and hot-reload wiring.
 */
import { getConfig, onConfigChange } from "../src/config.js";
import { getAgentRecords, getOrCreateAgent, removeAgent, syncAgentSessions } from "../src/agent.js";

async function stopSession(groupId, agentName = getConfig().groups?.[groupId]?.agent) {
    const agent = getAgentRecords().find((item) => item.key === agentName);
    const session = agent?.sessions[groupId];
    const created = session?.then ? await session.catch(() => null) : session;
    created?.stop();
    if (agent) delete agent.sessions[groupId];
}

async function stopUnusedSessions() {
    const groups = getConfig().groups || {};
    for (const agent of getAgentRecords()) {
        for (const groupId of Object.keys(agent.sessions)) {
            if (groups[groupId]?.agent === agent.key) continue;
            await stopSession(groupId, agent.key);
        }
    }
}

async function syncAgents() {
    for (const agentName of Object.keys(getConfig().agents)) getOrCreateAgent(agentName);
    await stopUnusedSessions();
    for (const agent of getAgentRecords()) {
        if (getConfig().agents[agent.key]) continue;
        removeAgent(agent.key);
    }
}

async function stopAgents() {
    for (const agent of getAgentRecords()) {
        for (const groupId of Object.keys(agent.sessions)) await stopSession(groupId, agent.key);
        agent.identityWatcher?.close();
    }
}

void syncAgents().then(() => syncAgentSessions());
onConfigChange(async () => {
    await syncAgents();
    await syncAgentSessions();
});

export default null;
