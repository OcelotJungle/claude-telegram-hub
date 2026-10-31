#!/usr/bin/env bash
# Disposable-container integration; the external deadline is rig's 5-minute readiness budget.
set -euo pipefail
[[ -f /.dockerenv && ${TELEGRAM_HUB_CONTAINER_TEST:-} == 1 ]] || { echo 'container fixture only' >&2; exit 1; }
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"
readonly readiness_budget_sec=300
timeout "$readiness_budget_sec" bun "$(dirname -- "${BASH_SOURCE[0]}")/check-hub-service.ts"
