#!/usr/bin/env bash
# One-shot discovery + reconcile. Writes config/sites-active.json.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
./setup.sh >/dev/null
exec node src/discover.js "$@"
