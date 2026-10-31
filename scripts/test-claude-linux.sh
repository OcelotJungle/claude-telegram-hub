#!/usr/bin/env bash
# No-login real-CLI probe in a disposable container; no model API is called.
set -euo pipefail
[[ -f /.dockerenv && ${TELEGRAM_HUB_CONTAINER_TEST:-} == 1 ]] || { echo 'container fixture only' >&2; exit 1; }
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
# Same outer smoke deadline as rig's readiness/rollback budget, never a simulated turn timeout.
readonly readiness_budget_sec=300
timeout "$readiness_budget_sec" bun "$(dirname -- "${BASH_SOURCE[0]}")/probe-claude-linux.ts"
