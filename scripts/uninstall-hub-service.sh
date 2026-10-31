#!/usr/bin/env bash
# Remove only tg-hub; linger may also be needed by the user's other services. Safe to run again, or when never installed.
set -euo pipefail
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
# A missing unit or an unreachable bus must not stop the cleanup of the files.
systemctl --user disable --now tg-hub.service || echo 'tg-hub.service was not enabled or could not be stopped' >&2
rm -f -- "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/tg-hub.service"
# Windows start the hub themselves again.
rm -f -- "${TG_HUB_STATE_DIR:-$HOME/.claude/channels/tg-hub}/service-managed"
systemctl --user daemon-reload || true
printf '%s\n' 'tg-hub.service removed; linger left enabled.'
