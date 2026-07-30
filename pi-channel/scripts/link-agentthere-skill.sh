#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$(cd -- "$SCRIPT_DIR/../skills/agentthere-guide" && pwd)"
SKILLS_DIR="${PI_AGENT_SKILLS_DIR:-$HOME/.pi/agent/skills}"
TARGET_DIR="$SKILLS_DIR/agentthere-guide"

if [[ ! -f "$SOURCE_DIR/SKILL.md" ]]; then
    echo "agentthere-guide skill not found: $SOURCE_DIR/SKILL.md" >&2
    exit 1
fi

mkdir -p "$SKILLS_DIR"

if [[ -L "$TARGET_DIR" ]]; then
    rm "$TARGET_DIR"
elif [[ -e "$TARGET_DIR" ]]; then
    backup="$TARGET_DIR.backup.$(date +%Y%m%d-%H%M%S)"
    mv "$TARGET_DIR" "$backup"
    echo "existing skill moved to $backup"
fi

ln -s "$SOURCE_DIR" "$TARGET_DIR"
echo "linked $TARGET_DIR -> $SOURCE_DIR"
