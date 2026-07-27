#!/bin/bash
# Setup git hooks for the repository
#
# Points git at the tracked hooks/ directory instead of copying into
# .git/hooks. Copying meant later edits to hooks/pre-commit silently never
# took effect, and the copy had to be re-run after every clone.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$REPO_ROOT"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
    echo "Error: not inside a git repository."
    exit 1
fi

if [ ! -f "hooks/pre-commit" ]; then
    echo "Error: hooks/pre-commit not found."
    exit 1
fi

chmod +x hooks/* 2>/dev/null || true
git config core.hooksPath hooks

echo "✓ core.hooksPath set to 'hooks'"
echo "  Active hooks: $(ls hooks | tr '\n' ' ')"
echo
echo "Edits to files in hooks/ now take effect immediately."
echo "To undo: git config --unset core.hooksPath"
