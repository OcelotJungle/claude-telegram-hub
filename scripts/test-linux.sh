#!/usr/bin/env bash
# Full Linux verification inside docker/ubuntu-24.04; retain output before reporting it.
set -euo pipefail
project_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd -- "$project_dir/plugin"
mkdir -p -- "$project_dir/reports"
# Bun tests run serially by default; concurrent tests are capped as well.
if ! bun run typecheck > "$project_dir/reports/linux-typecheck.log" 2>&1; then
  tail -n 20 "$project_dir/reports/linux-typecheck.log"
  exit 1
fi
status=0
bun test --max-concurrency 1 > "$project_dir/reports/linux-tests.log" 2>&1 || status=$?
tail -n 20 "$project_dir/reports/linux-tests.log"
exit "$status"
