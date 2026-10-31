#!/usr/bin/env bash
# Check this worktree using an existing dependency tree read-only, without installing Bun packages.
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
reference=$(cd -- "${1:?pass an existing plugin/node_modules directory}" && pwd)
temporary_root=${TEMP:?TEMP must point at the project temporary directory}
if command -v cygpath >/dev/null; then
  temporary_root=$(cygpath -u "$temporary_root")
fi
config=$(mktemp "$temporary_root/rig-types-XXXXXXXX.json")
trap 'rm -f -- "$config"' EXIT
config_path=$config
if command -v cygpath >/dev/null; then
  project_dir=$(cygpath -m "$project_dir")
  reference=$(cygpath -m "$reference")
  config_path=$(cygpath -m "$config")
fi
printf '{"extends":"%s/plugin/tsconfig.json","compilerOptions":{"baseUrl":"%s","typeRoots":["%s/@types"],"paths":{"@modelcontextprotocol/sdk/*":["%s/@modelcontextprotocol/sdk/dist/esm/*"]}},"include":["%s/plugin/src","%s/plugin/test","%s/scripts/check-hub-service.ts","%s/scripts/rig-service-process.ts","%s/scripts/claude-probe-terminal.ts","%s/scripts/probe-claude-linux.ts","%s/scripts/migrate-*.ts"]}\n' "$project_dir" "$reference" "$reference" "$reference" "$project_dir" "$project_dir" "$project_dir" "$project_dir" "$project_dir" "$project_dir" "$project_dir" > "$config"
node --preserve-symlinks-main "$reference/typescript/bin/tsc" --noEmit -p "$config_path"
