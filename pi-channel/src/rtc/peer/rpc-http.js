const HTTP_METHOD = /^(GET|POST|PUT|PATCH|DELETE|HEAD) (\/[^\s]*)$/;

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseHttpMethod(method) {
    const match = HTTP_METHOD.exec(method);
    return match ? { name: match[1], path: match[2] } : null;
}

function parseResponseBody(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return text;
    }
}

/**
 * Create an HTTP fallback handler for HTTP-style RPC methods such as:
 * GET /agent/command
 * POST /agent/command?q=123
 */
export function createHttpRpcHandler({
    baseUrl = "http://127.0.0.1:9001",
    groupId,
    peerId,
} = {}) {
    return (method) => {
        const request = parseHttpMethod(method);
        if (!request) return null;

        return async (params = {}) => {
            const headers = params?.header;
            if (headers !== undefined && !isObject(headers)) {
                throw Object.assign(new Error("params.header must be an object"), { code: -32602 });
            }

            const body = params?.body;
            const hasBody = body !== undefined && body !== null;
            if ((request.name === "GET" || request.name === "HEAD") && hasBody) {
                throw Object.assign(new Error(`${request.name} request cannot have a body`), { code: -32602 });
            }

            const requestHeaders = {
                ...(headers || {}),
                ...(groupId && !Object.keys(headers || {}).some((name) => name.toLowerCase() === "x-agentthere-group-id")
                    ? { "X-AgentThere-Group-Id": groupId }
                    : {}),
                ...(peerId && !Object.keys(headers || {}).some((name) => name.toLowerCase() === "x-agentthere-peer-id")
                    ? { "X-AgentThere-Peer-Id": peerId }
                    : {}),
            };
            const options = {
                method: request.name,
                ...(Object.keys(requestHeaders).length > 0 ? { headers: requestHeaders } : {}),
            };
            if (hasBody) {
                options.body = typeof body === "string" ? body : JSON.stringify(body);
                if (!Object.keys(requestHeaders).some((name) => name.toLowerCase() === "content-type")) {
                    options.headers = { ...(options.headers || {}), "content-type": "application/json" };
                }
            }

            console.log(`[agentthere:http-rpc] request ${request.name} ${request.path}`);
            const response = await fetch(`${baseUrl}${request.path}`, options);
            const text = await response.text();
            const responseBody = parseResponseBody(text);
            if (!response.ok) {
                throw Object.assign(new Error(`HTTP ${response.status}`), {
                    code: response.status,
                    data: responseBody,
                });
            }
            console.log(`[agentthere:http-rpc] response ${response.status} ${request.name} ${request.path}`);
            return responseBody;
        };
    };
}
