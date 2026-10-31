#!/usr/bin/env bash
# Service entry point: install exactly the locked dependencies before each start.
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
cd -- "$project_dir/plugin"
# The commit of the code bun is about to load, fixed before it starts; empty (the hub then asks git itself) when git fails.
TELEGRAM_HUB_COMMIT=$(git -C "$project_dir" rev-parse HEAD 2>/dev/null || true)
export TELEGRAM_HUB_COMMIT
bun install --frozen-lockfile --no-summary
exec bun src/hub/main.ts --always-on
