import { getPeers } from './rtc/index.js';

export function collectStatusIssues(accounts) {
    return accounts.flatMap(account => {
        if (account?.enabled && !account?.signalingConfigured) {
            return [
                {
                    channel: 'agentthere',
                    accountId: account.accountId,
                    kind: 'config',
                    message: 'MQTT signaling URL missing',
                    fix: 'Set channels.agentthere.mqtt.url or rerun the AgentThere setup flow.'
                }
            ];
        }
        return [];
    });
}

export function resolveConfiguredGroupIds(account) {
    if (Array.isArray(account.groupIds)) {
        return account.groupIds;
    }
    if (account.groups && typeof account.groups === 'object') {
        return Object.keys(account.groups);
    }
    return [];
}

export async function probeAgentThere(account, _timeoutMs) {
    const mqttUrl = account?.mqtt?.url;
    if (!mqttUrl) {
        return { ok: false, error: 'MQTT signaling URL missing' };
    }

    const peers = getPeers();
    const activeSessions = peers ? [...peers.values()].filter(peer => peer?.connected).length : 0;
    return {
        ok: true,
        signaling: {
            configured: true,
            url: mqttUrl
        },
        activeSessions
    };
}
