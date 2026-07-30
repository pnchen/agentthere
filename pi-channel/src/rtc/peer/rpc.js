/**
 * JSON-RPC 2.0 session.
 *
 * This module only knows about JSON-RPC and a transport function. It does not
 * know about WebRTC, HTTP, peer discovery, or application capabilities.
 */

const STANDARD_ERRORS = new Map([
    [-32600, "Invalid Request"],
    [-32601, "Method not found"],
    [-32602, "Invalid params"],
    [-32603, "Internal error"],
]);

export class RpcRemoteError extends Error {
    constructor({ code, message, data, id }) {
        super(message || "RPC error");
        this.name = "RpcRemoteError";
        this.code = code;
        this.data = data;
        this.id = id;
        this.rpc = true;
    }
}

export class RpcTransportError extends Error {
    constructor(message = "RPC transport failed", cause) {
        super(message, cause ? { cause } : undefined);
        this.name = "RpcTransportError";
        this.code = "RPC_TRANSPORT_ERROR";
        this.rpc = false;
    }
}

export class RpcTimeoutError extends Error {
    constructor(method, timeout) {
        super(`RPC timeout: ${method}`);
        this.name = "RpcTimeoutError";
        this.code = "RPC_TIMEOUT";
        this.method = method;
        this.timeout = timeout;
        this.rpc = false;
    }
}

function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidId(id) {
    return (typeof id === "string" && id.length > 0)
        || (typeof id === "number" && Number.isFinite(id));
}

function isValidParams(params) {
    // JSON-RPC params is optional. When present it must be structured JSON.
    return params === undefined || params === null || Array.isArray(params) || isObject(params);
}

function parseMessage(data) {
    let message;
    try {
        message = typeof data === "string" ? JSON.parse(data) : data;
    }
    catch {
        return null;
    }

    if (!isObject(message) || message.jsonrpc !== "2.0") return null;

    const hasId = hasOwn(message, "id");
    if (hasId && !isValidId(message.id)) return null;

    const hasMethod = hasOwn(message, "method");
    const hasResult = hasOwn(message, "result");
    const hasError = hasOwn(message, "error");

    if (hasMethod) {
        if (typeof message.method !== "string" || message.method.length === 0) return null;
        if (hasResult || hasError) return null;
        if (hasOwn(message, "params") && !isValidParams(message.params)) return null;
        return { kind: hasId ? "request" : "notification", message };
    }

    if (!hasId || (!hasResult && !hasError) || (hasResult && hasError)) return null;
    if (hasError && (!isObject(message.error)
        || !Number.isInteger(message.error.code)
        || typeof message.error.message !== "string")) return null;
    return { kind: "response", message };
}

function errorPayload(error) {
    const code = Number.isInteger(error?.code) ? error.code : -32603;
    const message = typeof error?.message === "string" && error.message
        ? error.message
        : STANDARD_ERRORS.get(code) || "Internal error";
    const payload = { code, message };
    if (error && hasOwn(error, "data")) payload.data = error.data;
    return payload;
}

function handlerError(error) {
    // A handler may deliberately throw an error with a JSON-RPC code/data.
    // Ordinary exceptions are deliberately reduced to -32603.
    if (Number.isInteger(error?.code)) return error;
    return Object.assign(new Error("Internal error"), { code: -32603 });
}

export function createRpc({ send, timeout = 30000, label = "?", fallback = null }) {
    if (typeof send !== "function") throw new TypeError("RPC send must be a function");

    const pending = new Map();
    const handlers = new Map();
    let nextId = 1;
    let destroyed = false;

    function sendText(text) {
        console.log(`[agentthere:rpc] send peer=${label} payload=${text.slice(0, 500)}`);
        let result;
        try {
            result = send(text);
        }
        catch (error) {
            return Promise.reject(new RpcTransportError("RPC transport threw while sending", error));
        }

        return Promise.resolve(result).then((ok) => {
            if (ok === false) throw new RpcTransportError();
            return ok;
        }, (error) => {
            throw error instanceof RpcTransportError
                ? error
                : new RpcTransportError("RPC transport rejected the message", error);
        });
    }

    function call(method, params) {
        console.log(`[agentthere:rpc] call method=${method} params=${JSON.stringify(params ?? null)}`);
        if (destroyed) return Promise.reject(new RpcTransportError("RPC session is destroyed"));
        if (typeof method !== "string" || method.length === 0) {
            return Promise.reject(Object.assign(new Error("RPC method must be a non-empty string"), { code: -32602 }));
        }
        if (!isValidParams(params)) {
            return Promise.reject(Object.assign(new Error("RPC params must be structured JSON"), { code: -32602 }));
        }

        const id = String(nextId++);
        const request = JSON.stringify({ jsonrpc: "2.0", method, params, id });

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new RpcTimeoutError(method, timeout));
            }, timeout);
            pending.set(id, { resolve, reject, timer, method });

            sendText(request).catch((error) => {
                const item = pending.get(id);
                if (!item) return;
                pending.delete(id);
                clearTimeout(item.timer);
                reject(error);
            });
        });
    }

    function sendResponse(response) {
        sendText(JSON.stringify(response)).catch((error) => {
            console.warn(`[agentthere/rpc] failed to send response: ${error.message}`);
        });
    }

    function handleResponse(message) {
        console.log(`[agentthere:rpc] response id=${message.id} ${hasOwn(message, "error") ? `error=${JSON.stringify(message.error)}` : `result=${JSON.stringify(message.result)?.slice(0, 500)}`}`);
        const item = pending.get(message.id);
        // A response for another session or a duplicate response is still a
        // valid JSON-RPC message, but it has no local request to resolve.
        if (!item) return;

        pending.delete(message.id);
        clearTimeout(item.timer);
        if (hasOwn(message, "error")) {
            item.reject(new RpcRemoteError({ ...message.error, id: message.id }));
        }
        else {
            item.resolve(message.result);
        }
    }

    function handleRequest(kind, message) {
        console.log(`[agentthere:rpc] request kind=${kind} id=${message.id ?? "-"} method=${message.method} params=${JSON.stringify(message.params ?? null)}`);
        const handler = handlers.get(message.method) || fallback?.(message.method);
        const hasId = kind === "request";
        const id = message.id;

        if (!handler) {
            if (hasId) {
                sendResponse({
                    jsonrpc: "2.0",
                    error: { code: -32601, message: `Method not found: ${message.method}` },
                    id,
                });
            }
            return;
        }

        Promise.resolve()
            .then(() => handler(message.params))
            .then((result) => {
                console.log(`[agentthere:rpc] request complete id=${id ?? "-"} method=${message.method} result=${JSON.stringify(result)?.slice(0, 500)}`);
                if (hasId) sendResponse({ jsonrpc: "2.0", result, id });
            })
            .catch((error) => {
                console.warn(`[agentthere:rpc] request failed id=${id ?? "-"} method=${message.method} code=${error?.code ?? "-"} error=${error?.message || error}`);
                if (hasId) {
                    sendResponse({
                        jsonrpc: "2.0",
                        error: errorPayload(handlerError(error)),
                        id,
                    });
                }
                console.warn(`[agentthere/rpc] handler error method=${message.method}: ${error?.message || error}`);
            });
    }

    /** Process one incoming transport message. */
    function handleMessage(data) {
        const parsed = parseMessage(data);
        if (!parsed) return false;

        if (parsed.kind === "response") handleResponse(parsed.message);
        else handleRequest(parsed.kind, parsed.message);
        return true;
    }

    /** Register or replace a runtime handler. Returns an unregister function. */
    function onRequest(method, handler) {
        if (typeof method !== "string" || method.length === 0) throw new TypeError("RPC method must be a non-empty string");
        if (typeof handler !== "function") throw new TypeError("RPC handler must be a function");
        handlers.set(method, handler);
        return () => {
            if (handlers.get(method) === handler) handlers.delete(method);
        };
    }

    function getMethods() {
        return [...handlers.keys()];
    }

    function destroy() {
        if (destroyed) return;
        destroyed = true;
        for (const item of pending.values()) {
            clearTimeout(item.timer);
            item.reject(new RpcTransportError("RPC session is destroyed"));
        }
        pending.clear();
        handlers.clear();
    }

    return { call, handleMessage, onRequest, getMethods, destroy };
}
