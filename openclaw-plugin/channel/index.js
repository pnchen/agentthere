import { defineBundledChannelEntry } from 'openclaw/plugin-sdk/channel-entry-contract';

const entry = defineBundledChannelEntry({
    id: 'agentthere',
    name: 'AgentThere',
    description: 'AgentThere — browser-to-agent terminal via WebRTC DataChannel + MQTT signaling',
    importMetaUrl: import.meta.url,
    plugin: {
        specifier: './src/plugin.js',
        exportName: 'agenttherePlugin'
    },
    runtime: {
        specifier: './src/runtime.js',
        exportName: 'setRuntime'
    }
});

export default entry;
