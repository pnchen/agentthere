/**
 * Auth gate middleware.
 *
 * Plain middleware — reads `ctx.dmPolicy`, `ctx.allowFrom`, `ctx.accountId`
 * that are injected via `services` by the composition root.
 * Three outcomes:
 *   1. allowed  → calls next()
 *   2. pairing  → sends pairing challenge, short-circuits
 *   3. blocked  → silent drop, short-circuits
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { resolveAllowlistMatchSimple } from 'openclaw/plugin-sdk/allow-from';
import { readChannelAllowFromStore } from 'openclaw/plugin-sdk/channel-pairing';
import { readStoreAllowFromForDmPolicy, resolveEffectiveAllowFromLists } from 'openclaw/plugin-sdk/channel-policy';
import { buildPairingReply } from 'openclaw/plugin-sdk/conversation-binding-runtime';
import { upsertChannelPairingRequest } from 'openclaw/plugin-sdk/conversation-runtime';

// ── UID label helpers ──────────────────────────────────────────
// Maintains a lightweight JSON file alongside the credentials dir
// so operators can see who each UID belongs to.

const LABELS_FILENAME = 'agentthere-uid-labels.json';

function resolveLabelsPath() {
    const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
    return path.join(home, 'credentials', LABELS_FILENAME);
}

let labelsCache = null;

function readLabels() {
    if (labelsCache) return labelsCache;
    try {
        const raw = fs.readFileSync(resolveLabelsPath(), 'utf-8');
        const parsed = JSON.parse(raw);
        labelsCache = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch {
        labelsCache = {};
    }
    return labelsCache;
}

function writeLabels(labels) {
    const filePath = resolveLabelsPath();
    try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(labels, null, 2) + '\n', 'utf-8');
    } catch {
        // best-effort
    }
}

function setUidLabel(uid, name) {
    if (!uid || !name) return;
    const trimmedUid = String(uid).trim();
    const trimmedName = String(name).trim();
    if (!trimmedUid || !trimmedName) return;

    const labels = readLabels();
    if (labels[trimmedUid] === trimmedName) return;
    labels[trimmedUid] = trimmedName;
    labelsCache = labels;
    writeLabels(labels);
}

export async function authGate(ctx, next) {
    const { uid, dmPolicy, allowFrom, accountId } = ctx;

    if (dmPolicy === 'open') {
        ctx.authResult = { allowed: true };
        await next();
        return;
    }

    if (!uid) return; // silent drop

    const configAllowFrom = Array.isArray(allowFrom) ? allowFrom : [];
    const storeAllowFrom = await readStoreAllowFromForDmPolicy({
        provider: 'agentthere',
        accountId,
        dmPolicy,
        readStore: (provider, id) => readChannelAllowFromStore(provider, process.env, id)
    }).catch(() => []);

    const { effectiveAllowFrom } = resolveEffectiveAllowFromLists({
        allowFrom: configAllowFrom,
        groupAllowFrom: [],
        storeAllowFrom,
        dmPolicy
    });

    let decision, reason;
    if (resolveAllowlistMatchSimple({ allowFrom: effectiveAllowFrom, senderId: uid }).allowed) {
        decision = 'allow';
        reason = `dmPolicy=${dmPolicy ?? 'pairing'} (allowlisted)`;
    } else if ((dmPolicy ?? 'pairing') === 'pairing') {
        decision = 'pairing';
        reason = 'dmPolicy=pairing (not allowlisted)';
    } else {
        decision = 'block';
        reason = `dmPolicy=${dmPolicy ?? 'disabled'} (not allowlisted)`;
    }

    if (decision === 'allow') {
        ctx.authResult = { allowed: true };
        await next();
        return;
    }

    console.log(`[${accountId}] auth: drop uid=${uid} (${reason})`);

    // Pairing flow
    if (decision === 'pairing') {
        try {
            setUidLabel(uid, ctx.peerName);
            const { code } = await upsertChannelPairingRequest({
                channel: 'agentthere',
                accountId,
                id: uid,
                meta: { name: ctx.peerName || undefined }
            });
            const text = buildPairingReply({
                channel: 'agentthere',
                idLine: `AgentThere UID: ${uid}`,
                code
            });
            ctx.res.send({ type: 'system', text });
        } catch (err) {
            console.error(`[${accountId}] pairing reply failed for uid=${uid}: ${String(err)}`);
        }
    }
    // Short-circuit
}
