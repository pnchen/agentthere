/**
 * Local OpenAI-compatible TTS adapter.
 *
 * Ported from OpenClaw's OpenAI speech provider. It calls the OpenAI
 * `/audio/speech` endpoint directly; no separate TTS service is required.
 */

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-4o-mini-tts";
const DEFAULT_VOICE = "coral";
const DEFAULT_RESPONSE_FORMAT = "opus";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_AUDIO_BYTES = 16 * 1024 * 1024;

const OPENAI_MODELS = new Set(["gpt-4o-mini-tts", "tts-1", "tts-1-hd"]);
const OPENAI_VOICES = new Set([
    "alloy", "ash", "ballad", "cedar", "coral", "echo", "fable",
    "juniper", "marin", "onyx", "nova", "sage", "shimmer", "verse",
]);
const RESPONSE_FORMATS = new Set(["mp3", "opus", "wav"]);

function normalizeBaseUrl(value) {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return (trimmed || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function sanitizeExtraBody(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        result[key] = entry;
    }
    return result;
}

function getProviderConfig(config) {
    const base = config?.providers?.openai;
    const persona = config?.persona ? config.personas?.[config.persona] : undefined;
    const personaProvider = persona?.providers?.openai;
    const baseConfig = base && typeof base === "object" && !Array.isArray(base) ? base : {};
    const personaConfig = personaProvider && typeof personaProvider === "object" && !Array.isArray(personaProvider)
        ? personaProvider
        : {};
    return { ...baseConfig, ...personaConfig };
}

function resolveConfig(config, overrides = {}) {
    const provider = getProviderConfig(config);
    const baseUrl = normalizeBaseUrl(provider.baseUrl);
    const model = String(overrides.model ?? provider.model ?? DEFAULT_MODEL).trim();
    const voice = String(overrides.voice ?? provider.voice ?? DEFAULT_VOICE).trim();
    const responseFormat = String(provider.responseFormat ?? DEFAULT_RESPONSE_FORMAT).trim().toLowerCase();
    const speed = overrides.speed ?? provider.speed;
    const timeoutMs = Number(config?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const instructions = typeof provider.instructions === "string" ? provider.instructions.trim() : "";
    const apiKey = typeof provider.apiKey === "string"
        ? provider.apiKey.trim()
        : process.env.OPENAI_API_KEY?.trim();

    if (!apiKey) throw new Error("OpenAI TTS API key is missing");
    if (!baseUrl) throw new Error("OpenAI TTS baseUrl is missing");
    if (!model) throw new Error("OpenAI TTS model is missing");
    if (!voice) throw new Error("OpenAI TTS voice is missing");
    if (!RESPONSE_FORMATS.has(responseFormat)) {
        throw new Error(`Invalid OpenAI TTS responseFormat: ${responseFormat}`);
    }
    if (baseUrl === DEFAULT_BASE_URL && !OPENAI_MODELS.has(model)) {
        throw new Error(`Invalid OpenAI TTS model: ${model}`);
    }
    if (baseUrl === DEFAULT_BASE_URL && !OPENAI_VOICES.has(voice)) {
        throw new Error(`Invalid OpenAI TTS voice: ${voice}`);
    }
    if (speed != null && (!Number.isFinite(Number(speed)) || Number(speed) < 0.25 || Number(speed) > 4)) {
        throw new Error(`Invalid OpenAI TTS speed: ${speed}`);
    }

    return {
        apiKey,
        baseUrl,
        model,
        voice,
        responseFormat,
        speed: speed == null ? undefined : Number(speed),
        instructions: model.includes("gpt-4o-mini-tts") ? instructions || undefined : undefined,
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : DEFAULT_TIMEOUT_MS,
        extraBody: sanitizeExtraBody(provider.extraBody ?? provider.extra_body),
    };
}

export async function synthesizeOpenAiSpeech({ text, config, overrides, signal }) {
    const resolved = resolveConfig(config, overrides);
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason);
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => controller.abort(), resolved.timeoutMs);

    try {
        const body = {
            model: resolved.model,
            input: text,
            voice: resolved.voice,
            response_format: resolved.responseFormat,
            ...(resolved.speed == null ? {} : { speed: resolved.speed }),
            ...(resolved.instructions == null ? {} : { instructions: resolved.instructions }),
            ...(resolved.extraBody ?? {}),
        };
        const response = await fetch(`${resolved.baseUrl}/audio/speech`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${resolved.apiKey}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
            signal: controller.signal,
        });

        if (!response.ok) {
            const detail = (await response.text()).slice(0, 500);
            throw new Error(`OpenAI TTS API ${response.status}: ${detail}`);
        }

        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > MAX_AUDIO_BYTES) {
            throw new Error(`OpenAI TTS audio exceeds ${MAX_AUDIO_BYTES} bytes`);
        }

        const audioBuffer = Buffer.from(await response.arrayBuffer());
        if (audioBuffer.length > MAX_AUDIO_BYTES) {
            throw new Error(`OpenAI TTS audio exceeds ${MAX_AUDIO_BYTES} bytes`);
        }
        return {
            success: true,
            audioBuffer,
            outputFormat: resolved.responseFormat,
        };
    }
    finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abortFromCaller);
    }
}
