import { randomUUID } from 'node:crypto';

// ── message IDs ──────────────────────────────────────────────────────────

export function createMessageId() {
    const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
    return `agentthere-${Date.now()}-${suffix}`;
}

export function buildOutboundTextMessage({ text, agentProfile }) {
    return {
        id: createMessageId(),
        text,
        from: agentProfile
    };
}

// ── target parsing / normalization ──────────────────────────────────────

export function parseMessagingTarget(raw) {
    const normalized = normalizeMessagingTarget(raw);
    if (!normalized) return null;

    if (normalized.startsWith('group:')) {
        return { kind: 'group', id: normalized.slice('group:'.length), normalized };
    }

    return { kind: 'direct', id: normalized.slice('peer:'.length), normalized };
}

export function normalizeMessagingTarget(raw) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed) return undefined;

    if (trimmed.startsWith('#')) {
        const group = trimmed.slice(1).trim();
        return group ? `group:${group}` : undefined;
    }
    if (trimmed.startsWith('@')) {
        const peerId = trimmed.slice(1).trim();
        return peerId ? `peer:${peerId}` : undefined;
    }

    const withoutProvider = trimmed.replace(/^agentthere:/i, '');
    const prefixedMatch = /^(group|channel|peer|user|dm|direct):(.*)$/i.exec(withoutProvider);
    if (prefixedMatch) {
        const [, rawKind, rawValue] = prefixedMatch;
        const value = rawValue.trim();
        if (!value) return undefined;
        return /^(group|channel)$/i.test(rawKind) ? `group:${value}` : `peer:${value}`;
    }

    if (withoutProvider.includes(':')) return undefined;
    if (/\s/.test(withoutProvider)) return undefined;

    return `peer:${withoutProvider}`;
}

export function looksLikeTargetId(raw) {
    return Boolean(normalizeMessagingTarget(raw));
}

export function formatTargetDisplay(params) {
    const formatted = typeof params.display === 'string' ? params.display.trim() : '';
    if (formatted) return formatted;

    const parsed = parseMessagingTarget(params.target);
    if (!parsed) return typeof params.target === 'string' ? params.target.trim() : '';

    return parsed.kind === 'group' ? `#${parsed.id}` : `@${parsed.id}`;
}

export function resolveOutboundSessionRoute(params) {
    const normalized = params.resolvedTarget?.to ?? normalizeMessagingTarget(params.target);
    const parsed = parseMessagingTarget(normalized);
    if (!parsed) return null;

    if (parsed.kind === 'group') {
        const sessionKey = `agentthere:group:${parsed.id}`;
        return {
            sessionKey,
            baseSessionKey: sessionKey,
            peer: { kind: 'group', id: parsed.id },
            chatType: 'group',
            from: params.accountId,
            to: `agentthere:group:${parsed.id}`,
            ...(params.threadId == null ? {} : { threadId: params.threadId })
        };
    }

    const sessionKey = `agentthere:${params.accountId}:${parsed.id}`;
    return {
        sessionKey,
        baseSessionKey: sessionKey,
        peer: { kind: 'direct', id: parsed.id },
        chatType: 'direct',
        from: params.accountId,
        to: parsed.id,
        ...(params.threadId == null ? {} : { threadId: params.threadId })
    };
}
