#!/usr/bin/env bash
# Install telegram-hub for the current Linux user, including boot without an SSH login.
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
bun_path=$(command -v bun || command -v "$HOME/.bun/bin/bun" || command -v "$HOME/.local/bin/bun") || { echo 'bun is not on PATH' >&2; exit 1; }
user_name=$(id -un)
# How long to wait for the user manager and its bus after enabling linger.
readonly bus_wait_sec=30
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
if [[ $(loginctl show-user "$user_name" -p Linger --value 2>/dev/null || true) != yes ]]; then
  loginctl enable-linger "$user_name"
fi
# Linger starts the user manager asynchronously: the first systemctl --user call can come before its bus exists.
bus_ready=0
for ((waited = 0; waited < bus_wait_sec; waited++)); do
  if systemctl --user show-environment >/dev/null 2>&1; then bus_ready=1; break; fi
  sleep 1
done
(( bus_ready )) || { echo "the user systemd bus did not appear in ${bus_wait_sec}s" >&2; exit 1; }
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p -- "$unit_dir"
# systemd strings quote backslashes and quotes; % introduces a specifier.
unit_quote() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  printf '"%s"' "$value"
}
entry="$project_dir/scripts/run-hub-service.sh"
# ExecStart additionally expands $ even inside quotes.
entry=${entry//\$/\$\$}
# A service gets a minimal search path without the user's tool directories (rig, bun), so the unit carries its own, fixed one.
unit_path="$HOME/.local/bin:$HOME/.bun/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
case ":$unit_path:" in
  *":$(dirname -- "$bun_path"):"*) ;;
  *) unit_path="$(dirname -- "$bun_path"):$unit_path" ;;
esac
{
  # StartLimitIntervalSec= belongs to [Unit]; 0 lifts the start limit, so a fast failure at boot (no network yet) retries for good.
  printf '%s\n' '[Unit]' 'Description=Telegram hub for Claude Code' 'StartLimitIntervalSec=0' '' '[Service]' 'Type=simple'
  # WorkingDirectory= takes the raw path: systemd does not unquote it, only expands % specifiers.
  work_dir="$project_dir/plugin"
  printf 'WorkingDirectory=%s\n' "${work_dir//%/%%}"
  printf 'Environment=%s\n' "$(unit_quote "PATH=$unit_path")"
  # The hub and the windows must read the same state directory: the marker below lives there.
  if [[ -n ${TELEGRAM_HUB_STATE_DIR:-} ]]; then printf 'Environment=%s\n' "$(unit_quote "TELEGRAM_HUB_STATE_DIR=$TELEGRAM_HUB_STATE_DIR")"; fi
  printf 'ExecStart=/usr/bin/bash %s\n' "$(unit_quote "$entry")"
  printf '%s\n' 'Restart=always' 'RestartSec=2' 'KillMode=process' '' '[Install]' 'WantedBy=default.target'
} > "$unit_dir/telegram-hub.service"
systemctl --user daemon-reload
# From now on windows only wait for the hub and connect to it; they do not start one (plugin/src/plugin/main.ts).
# The marker comes before the start: a window open during the install must not start a hub of its own meanwhile.
state_dir="${TELEGRAM_HUB_STATE_DIR:-$HOME/.claude/channels/telegram-hub}"
mkdir -p -- "$state_dir"
: > "$state_dir/service-managed"
# A service that does not start must not leave windows waiting for a hub that nobody runs.
systemctl --user enable --now telegram-hub.service || { rm -f -- "$state_dir/service-managed"; exit 1; }
printf '%s\n' 'telegram-hub.service installed and started; linger enabled.'
