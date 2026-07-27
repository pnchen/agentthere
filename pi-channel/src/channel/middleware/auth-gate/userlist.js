/**
 * User list — append-only JSONL file for per-user access control.
 *
 * Stored at <homeDir>/users.jsonl.
 * One JSON object per line, keys in snake_case.
 *
 *   {"user_id":"player001","agents":["default","writer"],"status":"authorized","pair_code":"","alias":"Bob","created_at":"2026-07-25T10:30:00+08:00"}
 *   {"user_id":"player002","agents":["default"],"status":"pending","pair_code":"ABC123","alias":"","created_at":"2026-07-25T10:31:00+08:00"}
 *
 * `agents` is intentionally independent of groups. Every record must declare
 * its allowed Agents; a missing or invalid `agents` field denies access.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getConfigHomeDir } from "../../../config.js";

const PAIR_CODE_LENGTH = 6;
const PAIR_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I

function generatePairCode() {
    let code = "";
    for (let i = 0; i < PAIR_CODE_LENGTH; i++) {
        code += PAIR_CODE_ALPHABET[crypto.randomInt(PAIR_CODE_ALPHABET.length)];
    }
    return code;
}

function isoNow() {
    return new Date().toISOString();
}

/** Load the full user list from disk as an in-memory map. */
export function loadUserList() {
    const homeDir = getConfigHomeDir();
    const filePath = path.join(homeDir, "users.jsonl");
    const users = Object.create(null);
    try {
        const content = fs.readFileSync(filePath, "utf-8");
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const entry = JSON.parse(trimmed);
                if (entry.user_id) users[entry.user_id] = entry;
            }
            catch {
                // skip malformed lines
            }
        }
    }
    catch {
        // missing file = empty list
    }
    return users;
}

/**
 * Append a pending user entry and return its pair code.
 * The file is read on every call; it is the source of truth.
 * If the user already exists, return the current pending pair code.
 * @param {string} userId
 * @param {string} [alias] — optional display name
 * @param {string} [agentName] — config Agent key requesting access
 */
export function registerPendingUser(userId, alias, agentName) {
    const homeDir = getConfigHomeDir();
    const users = loadUserList();
    const existing = users[userId];
    if (existing) {
        // Pending records may request access to more than one Agent. Append a
        // new version of the JSONL record so the last line remains authoritative.
        // Authorized records are never expanded automatically.
        if (existing.status === "pending" && Array.isArray(existing.agents) && agentName &&
            !existing.agents.includes(agentName) && !existing.agents.includes("*")) {
            const updated = { ...existing, agents: [...existing.agents, agentName] };
            fs.mkdirSync(homeDir, { recursive: true });
            const filePath = path.join(homeDir, "users.jsonl");
            fs.appendFileSync(filePath, JSON.stringify(updated) + "\n", "utf-8");
        }
        return existing.pair_code || null;
    }

    const pairCode = generatePairCode();
    const entry = {
        user_id: userId,
        ...(agentName ? { agents: [agentName] } : { agents: [] }),
        status: "pending",
        pair_code: pairCode,
        alias: alias || "",
        created_at: isoNow(),
    };

    fs.mkdirSync(homeDir, { recursive: true });
    const filePath = path.join(homeDir, "users.jsonl");
    fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
    return pairCode;
}

/**
 * Check whether a user is authorized for one Agent.
 * Groups are deliberately not part of this decision.
 * Returns { authorized, reason, pair_code? }
 *
 * Records without a valid `agents` array are denied. New records always carry
 * an `agents` array.
 */
export function checkUserAccess(userId, allowFrom, agentName) {
    // Static allowFrom (config) takes priority. This remains a group-level
    // configuration escape hatch; users.jsonl itself is Agent-scoped.
    if (allowFrom?.includes("*") || allowFrom?.includes(userId)) {
        return { authorized: true, reason: "allow_from" };
    }

    const users = loadUserList();
    const entry = users[userId];

    if (!entry) {
        return { authorized: false, reason: "not_registered" };
    }

    const hasAgentAccess = Array.isArray(entry.agents) &&
        (entry.agents.includes("*") ||
            (agentName && entry.agents.includes(agentName)));

    if (!hasAgentAccess) {
        return { authorized: false, reason: "agent_not_allowed" };
    }
    if (entry.status === "authorized") {
        return { authorized: true, reason: "user_list" };
    }
    if (entry.status === "pending") {
        return { authorized: false, reason: "pending", pair_code: entry.pair_code };
    }
    return { authorized: false, reason: "unknown" };
}
