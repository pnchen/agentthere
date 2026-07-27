function normalizeCommandName(name) {
    return String(name || "").replace(/^\//, "");
}

export function getSessionCommands(session) {
    const commands = typeof session.getCommands === "function" ? session.getCommands() : [];
    return commands.map((command) => ({
        ...command,
        name: normalizeCommandName(command.name),
    }));
}

export function isKnownCommand(session, text) {
    const match = /^\/([^\s]+)(?:\s|$)/.exec(String(text || "").trim());
    if (!match) return false;
    const name = normalizeCommandName(match[1]);
    return getSessionCommands(session).some((command) => command.name === name);
}
