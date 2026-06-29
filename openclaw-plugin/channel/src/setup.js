import { agenttherePlugin } from './plugin.js';

function patchConfig(params) {
    const channel = params.cfg.channels?.agentthere ?? {};
    const nextMqtt = {
        ...(channel.mqtt ?? {}),
        ...(params.mqttPatch ?? {})
    };
    const nextAgent = {
        ...(channel.agent ?? {}),
        ...(params.agentPatch ?? {})
    };

    return {
        ...params.cfg,
        channels: {
            ...params.cfg.channels,
            agentthere: {
                ...channel,
                ...(params.enabled === undefined ? {} : { enabled: params.enabled }),
                ...(Object.keys(nextMqtt).length === 0 ? {} : { mqtt: nextMqtt }),
                ...(Object.keys(nextAgent).length === 0 ? {} : { agent: nextAgent })
            }
        }
    };
}

const agentthereSetupAdapter = {
    resolveAccountId: () => 'default',
    applyAccountName: ({ cfg, name }) => {
        const trimmed = typeof name === 'string' ? name.trim() : '';
        return trimmed ? patchConfig({ cfg, agentPatch: { name: trimmed } }) : cfg;
    },
    validateInput: ({ cfg, input }) => {
        const configuredUrl = cfg.channels?.agentthere?.mqtt?.url;
        const providedUrl = input?.url ?? input?.httpUrl;
        if (configuredUrl || providedUrl) {
            return null;
        }
        return 'AgentThere requires MQTT signaling URL (--url or --http-url).';
    },
    applyAccountConfig: ({ cfg, input }) => {
        const url = input?.url ?? input?.httpUrl;
        const mqttPatch = {
            ...(typeof url === 'string' && url.trim() ? { url: url.trim() } : {}),
            ...(typeof input?.userId === 'string' && input.userId.trim() ? { username: input.userId.trim() } : {}),
            ...(typeof input?.token === 'string' && input.token.trim() ? { password: input.token.trim() } : {})
        };

        return patchConfig({
            cfg,
            enabled: true,
            mqttPatch
        });
    }
};

export const agentthereSetupPlugin = {
    ...agenttherePlugin,
    setup: agentthereSetupAdapter
};
