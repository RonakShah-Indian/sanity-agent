#!/usr/bin/env bash
# First-time setup for autonomous-sanity-agent.
# Idempotent: safe to re-run; fast when nothing needs doing.
set -euo pipefail

cd "$(dirname "$0")"

step() { printf "\033[1;36m[%s]\033[0m %s\n" "$1" "$2"; }
ok()   { printf "\033[1;32m  OK\033[0m  %s\n" "$1"; }
warn() { printf "\033[1;33m  !!\033[0m  %s\n" "$1"; }
die()  { printf "\033[1;31m  XX\033[0m  %s\n" "$1"; exit 1; }

START=$(date +%s)

# ---- 1/3  Node ---------------------------------------------------------------
step "1/3" "Checking Node.js"
command -v node >/dev/null 2>&1 || die "node not found. Install Node 18+ (https://nodejs.org) and re-run."
NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
[ "$NODE_MAJOR" -ge 18 ] || die "Node $NODE_MAJOR detected; need >= 18."
ok "Node $(node -v)"

# ---- 2/3  npm deps -----------------------------------------------------------
step "2/3" "Installing JS dependencies"
if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ package-lock.json -nt node_modules ]; then
  npm install --no-audit --no-fund --loglevel=error
  ok "npm packages installed"
else
  ok "npm packages up to date (skipped)"
fi

# ---- 3/3  Playwright browsers ------------------------------------------------
# Headless launches need BOTH chromium and the chrome-headless-shell variant.
# `playwright install` is itself idempotent — downloads only what's missing.
step "3/3" "Ensuring Playwright browsers (chromium + headless shell)"
npx --yes playwright install chromium chromium-headless-shell
ok "Browsers ready"

END=$(date +%s)
printf "\n\033[1;32mSetup complete in %ss.\033[0m\n" "$((END - START))"

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  printf "\033[2m(optional) export ANTHROPIC_API_KEY=sk-ant-... to enable LLM vision fallback + diagnosis.\033[0m\n"
fi

printf "\nRun the agent:\n  ./run.sh                                                              # default sites (config/sites.json)\n  ./run.sh --sites config/fynd-assignment-sites.json --concurrency 1   # 3-site assignment demo\n"
