/**
 * AgentThere plugin runtime singleton.
 *
 * Stores the PluginRuntime injected by the OpenClaw plugin host so other
 * modules can access AI dispatch, logging, and config facilities without
 * threading the object through every call site.
 */

/** @type {import("openclaw/plugin-sdk").PluginRuntime | undefined} */
let _runtime;

export function setRuntime(runtime) {
    _runtime = runtime;
}

export function getRuntime() {
    if (!_runtime) {
        throw new Error('[agentthere] Runtime not initialized — did setRuntime() run?');
    }
    return _runtime;
}
