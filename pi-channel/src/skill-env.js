import fs from "node:fs";
import { createBashToolDefinition, parseFrontmatter } from "@earendil-works/pi-coding-agent";

const DANGEROUS_ENV_NAMES = new Set([
    "PATH",
    "LD_PRELOAD",
    "DYLD_INSERT_LIBRARIES",
    "HOME",
    "SHELL",
    "PWD",
    "OLDPWD",
    "NODE_OPTIONS",
]);

export function validEnvName(name) {
    return /^[A-Z_][A-Z0-9_]*$/.test(name) && !DANGEROUS_ENV_NAMES.has(name);
}

export function readSkillMetadata(skill) {
    try {
        const content = fs.readFileSync(skill.filePath, "utf-8");
        const frontmatter = parseFrontmatter(content).frontmatter;
        const metadata = frontmatter?.metadata;
        if (!metadata || typeof metadata !== "object") return null;
        const requires = metadata.requires && typeof metadata.requires === "object"
            ? metadata.requires
            : {};
        return {
            name: skill.name,
            primaryEnv: typeof metadata.primaryEnv === "string" ? metadata.primaryEnv : undefined,
            requiresEnv: Array.isArray(requires.env) ? requires.env.filter((name) => typeof name === "string") : [],
        };
    }
    catch (err) {
        console.warn(`[skill-env] unable to read ${skill.filePath}: ${String(err)}`);
        return null;
    }
}

export function resolveSkillEnv({ skills, agentConfig, agentName = "unknown" }) {
    const entries = agentConfig?.skills?.entries || {};
    const resolved = new Map();
    const conflicts = [];

    for (const skill of skills) {
        const metadata = readSkillMetadata(skill);
        if (!metadata) continue;
        const entry = entries[metadata.name];
        if (!entry) continue;

        const allowed = new Set(metadata.requiresEnv);
        const values = {};
        if (metadata.primaryEnv && entry.apiKey !== undefined) {
            values[metadata.primaryEnv] = String(entry.apiKey);
        }
        for (const [name, value] of Object.entries(entry.env || {})) {
            if (allowed.has(name)) values[name] = String(value);
        }

        for (const [name, value] of Object.entries(values)) {
            if (!validEnvName(name) || !allowed.has(name) && name !== metadata.primaryEnv) {
                console.warn(`[skill-env] rejected ${name} from skill ${metadata.name}`);
                continue;
            }
            const previous = resolved.get(name);
            if (previous && previous.value !== value) {
                conflicts.push(`${name}: ${previous.skill} vs ${metadata.name}`);
                continue;
            }
            resolved.set(name, { value, skill: metadata.name });
            console.log(`[skill-env] agent=${agentName} skill=${metadata.name} injected ${name}`);
        }
    }

    if (conflicts.length) {
        throw new Error(`conflicting skill environment values: ${conflicts.join(", ")}`);
    }
    return new Map([...resolved].map(([name, item]) => [name, item.value]));
}

export function createAgentBashTool({ workspaceDir, skills, getAgentConfig, agentName }) {
    return createBashToolDefinition(workspaceDir, {
        spawnHook({ command, cwd, env: inheritedEnv }) {
            const env = resolveSkillEnv({
                skills,
                agentConfig: getAgentConfig(),
                agentName,
            });
            return {
                command,
                cwd,
                env: { ...inheritedEnv, ...Object.fromEntries(env) },
            };
        },
    });
}
