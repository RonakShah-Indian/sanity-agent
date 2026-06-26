## Autonomous Sanity Agent — convenience targets.
## One source of truth for the common workflows. Run `make help` for the list.

ROOT     := $(shell pwd)
SITES    ?= config/sites.json
CONC     ?= 3
TIME_MS  ?= 600000
PORT     ?= 8787

.DEFAULT_GOAL := help

.PHONY: help setup test run serve demo clean clean-state all status \
        gate-allow alerts-enable alerts-status fynd-demo fynd-demo-headed \
        discover-pages videos-to-mp4 docker-build docker-up docker-down dashboard

## ---------------------------------------------------------------------------
## Discovery / running
## ---------------------------------------------------------------------------

setup: ## First-time install (Node check + npm deps + Playwright browsers)
	./setup.sh

run: ## One-shot run against $(SITES). Overrides: SITES=... CONC=... TIME_MS=...
	./run.sh --sites $(SITES) --concurrency $(CONC) --time $(TIME_MS)

serve: ## Long-running daemon: webhook + version poller + dashboard on :$(PORT)
	./serve.sh --port $(PORT) --sites $(SITES)

dashboard: ## Open the live dashboard (requires serve to be running)
	@open "http://localhost:$(PORT)/dashboard" || xdg-open "http://localhost:$(PORT)/dashboard" || echo "Open http://localhost:$(PORT)/dashboard manually"

docker-build: ## Build the production container image (Phase 10)
	docker build -t sanity-agent:latest .

docker-up: ## Run the production container (Phase 10) — daemon on :$(PORT)
	docker compose up --build -d
	@echo "Dashboard: http://localhost:$(PORT)/dashboard"

docker-down: ## Stop the production container
	docker compose down

discover: ## One-shot discovery + reconciliation using config/discovery.example.json
	./discover.sh --config config/discovery.example.json

test: ## Run the full unit-test suite (no browser, ~3s)
	npm test --silent

## ---------------------------------------------------------------------------
## Demos (each is the "show this to the CTO" flow)
## ---------------------------------------------------------------------------

demo: ## End-to-end: setup → tests → headed run against the 3 Fynd assignment sites
	@$(MAKE) -s setup
	@$(MAKE) -s test
	@$(MAKE) -s run SITES=config/fynd-assignment-sites.json CONC=1 TIME_MS=600000

fynd-demo: ## Run against the 3 Fynd assignment sites (config/fynd-assignment-sites.json)
	./run.sh --sites config/fynd-assignment-sites.json --concurrency 1 --time 600000

fynd-demo-headed: ## Same as fynd-demo but the browser windows are VISIBLE
	./run.sh --headed --sites config/fynd-assignment-sites.json --concurrency 1 --time 600000

discover-pages: ## Per-site page crawl (Phase 2). URL=https://example.com [MAX=25] [DEPTH=2]
	@if [ -z "$(URL)" ]; then echo "Usage: make discover-pages URL=https://example.com"; exit 2; fi
	node src/discover-pages.js --url $(URL) --max $${MAX:-25} --depth $${DEPTH:-2}

profile-rollback: ## Drop a bad cached selector. SITE=site-id [INTENT=add_to_cart] [VP=desktop] [DRY=1]
	@if [ -z "$(SITE)" ]; then echo "Usage: make profile-rollback SITE=sephora-india [INTENT=add_to_cart] [VP=desktop] [DRY=1]"; exit 2; fi
	node src/profile-rollback.js --site $(SITE) $${VP:+--viewport $(VP)} $${INTENT:+--intent $(INTENT)} $${DRY:+--dry-run}

videos-to-mp4: ## Convert all .webm recordings to .mp4 (requires ffmpeg: brew install ffmpeg)
	@command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not found. Install with: brew install ffmpeg"; exit 1; }
	@for f in $$(find reports/_videos -name '*.webm'); do \
	  out="$${f%.webm}.mp4"; \
	  echo "  converting $$f → $$out"; \
	  ffmpeg -loglevel error -y -i "$$f" -c:v libx264 -pix_fmt yuv420p "$$out"; \
	done
	@echo "Done. MP4s sit next to the originals."

## ---------------------------------------------------------------------------
## Canary gate (block a deploy if the agent verdict regressed)
## ---------------------------------------------------------------------------

alerts-enable: ## Copy config/alerts.example.json → config/alerts.json (then set SLACK_WEBHOOK_URL)
	@if [ ! -f config/alerts.json ]; then cp config/alerts.example.json config/alerts.json; echo "config/alerts.json created. Set SLACK_WEBHOOK_URL in .env.local to wire it up."; else echo "config/alerts.json already exists."; fi

alerts-status: ## Show alert dedup state (which events have been paged recently)
	@ls alerts-state/ 2>/dev/null | sed 's/\.json$$//' | sed 's/^/  • /' || echo "  (no alerts fired yet)"

gate-allow: ## Sanity check: compare the latest report to itself → should ALLOW
	@LATEST=$$(ls -td reports/run-* 2>/dev/null | head -1); \
	if [ -z "$$LATEST" ]; then echo "No reports yet — run \`make run\` first."; exit 1; fi; \
	node src/canary-gate.js --current $$LATEST/results.json --baseline $$LATEST/results.json

## ---------------------------------------------------------------------------
## Status / cleanup
## ---------------------------------------------------------------------------

status: ## Summary of state on disk
	@echo "Reports:           $$(ls reports/ 2>/dev/null | wc -l | tr -d ' ') runs"
	@echo "Profiles learned:  $$(ls profiles/*.json 2>/dev/null | wc -l | tr -d ' ') variants"
	@echo "History records:   $$(ls history/*.jsonl 2>/dev/null | wc -l | tr -d ' ') merchants"
	@echo "Visual baselines:  $$(ls visual-baselines/*.bin 2>/dev/null | wc -l | tr -d ' ') images"
	@echo "Discovery active:  $$([ -f config/sites-active.json ] && echo yes || echo no)"

clean: ## Remove run reports (keeps learned state)
	rm -rf reports/*

clean-state: ## Nuke ALL learned state (profiles, history, baselines). Next run starts fresh.
	rm -rf reports/* profiles/* history/* baselines/* visual-baselines/* config/sites-active.json

## ---------------------------------------------------------------------------

all: ## Setup, test, and run one demo. The "I just cloned this" path.
	@$(MAKE) -s setup
	@$(MAKE) -s test
	@$(MAKE) -s fynd-demo

help: ## This help
	@echo "Autonomous Sanity Agent — make targets"
	@echo ""
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo ""
	@echo "Overridable vars: SITES, CONC, TIME_MS, PORT  (e.g. make run SITES=config/fynd-assignment-sites.json)"
