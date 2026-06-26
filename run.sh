#!/usr/bin/env bash
# One-command launcher: ensures setup, then runs the agent.
# Pass any flags through to src/index.js (e.g. --sites, --concurrency, --time).
set -euo pipefail

cd "$(dirname "$0")"

# Auto-load local env vars (e.g. ANTHROPIC_API_KEY) from .env.local if present.
# File format: one KEY=VALUE per line, no quotes needed. Never commit this file.
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

# Translate convenience flags --headed / --record into env vars the agent reads.
ARGS=()
for a in "$@"; do
  case "$a" in
    --headed) export SANITY_HEADED=1 ;;
    --record) export SANITY_RECORD=1; export SANITY_HEADED=1 ;;   # recording implies headed for sanity
    *)        ARGS+=("$a") ;;
  esac
done
set -- "${ARGS[@]}"

# setup.sh is idempotent — fast when nothing is missing. Always run it.
./setup.sh
echo ""
if [ "${SANITY_HEADED:-0}" = "1" ]; then echo "[run] headed mode ON (browser windows will appear)"; fi
if [ "${SANITY_RECORD:-0}" = "1" ]; then echo "[run] recording ON (videos → reports/_videos/<site>/)"; fi


if [ "$#" -eq 0 ]; then
  exec node src/index.js --sites config/sites.json
else
  exec node src/index.js "$@"
fi
