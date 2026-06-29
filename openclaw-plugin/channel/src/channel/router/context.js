/**
 * Context — standard ctx shape for the middleware pipeline.
 *
 * Every ctx that enters `router.process()` is built through `createContext`.
 * Middleware can rely on these fields; services are spread in by the caller.
 */

/**
 * @param {object} opts
 * @param {string}  opts.peerId
 * @param {string}  opts.peerName
 * @param {string}  [opts.uid]
 * @param {string}  [opts.groupId]
 * @param {number}  [opts.peerCount]
 * @param {string}  [opts.text]
 * @param {string}  [opts.cleanText]
 * @param {boolean} [opts.mentioned]
 * @param {string}  [opts.mediaUrl]
 * @param {string}  [opts.fileName]
 * @param {string}  [opts.mimeType]
 * @param {object}  opts.runtime
 * @param {object}  opts.cfg
 * @param {string}  opts.accountId
 * @param {AbortSignal} opts.abortSignal
 * @param {string}  [opts.path]
 */
export function createContext(opts) {
    return {
        // ── message identity ──────────────────────────
        peerId: opts.peerId,
        peerName: opts.peerName,
        uid: opts.uid ?? null,
        groupId: opts.groupId ?? null,
        peerCount: opts.peerCount ?? 0,

        // ── message content ───────────────────────────
        text: opts.text ?? '',
        cleanText: opts.cleanText ?? opts.text ?? '',
        mentioned: opts.mentioned ?? false,

        // ── media ──────────────────────────────────────
        mediaUrl: opts.mediaUrl ?? null,
        fileName: opts.fileName ?? null,
        mimeType: opts.mimeType ?? null,

        // ── runtime ────────────────────────────────────
        runtime: opts.runtime,
        cfg: opts.cfg,
        accountId: opts.accountId,
        abortSignal: opts.abortSignal,
        path: opts.path ?? null,

        // ── response ───────────────────────────────────
        res: opts.res ?? null,
        msgId: opts.msgId ?? null,
        agentProfile: opts.agentProfile ?? null,
        presetBubble: opts.presetBubble ?? false,

        // ── pre-resolved group config ──────────────────
        groupSkillFilter: opts.groupSkillFilter,
        groupSystemPrompt: opts.groupSystemPrompt,
        groupAgentId: opts.groupAgentId,
        verbose: opts.verbose,

        // ── pre-resolved route (set by start-account.js) ─
        routedSessionKey: opts.routedSessionKey,
        routedAccountId: opts.routedAccountId
    };
}
