#!/usr/bin/env bash
# Long-running mode: webhook + version-poller stay up until killed.
# Pass-through flags: --port 8787 --interval 60000 --sites config/sites.json
set -euo pipefail
cd "$(dirname "$0")"

# Auto-load local env vars (e.g. ANTHROPIC_API_KEY, DEPLOY_SECRET).
if [ -f .env.local ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.local
  set +a
fi

./setup.sh
echo ""
exec node src/serve.js "$@"
