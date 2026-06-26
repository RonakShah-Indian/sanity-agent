# Phase 10 production image. Single stage — Node + Playwright + the agent.
# Playwright provides an official Node image with all browser deps baked in,
# which is the cleanest way to avoid the apt-get dance.
FROM mcr.microsoft.com/playwright:v1.45.0-jammy

WORKDIR /app

# Install deps first so they cache when only source changes.
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy source.
COPY src/    ./src/
COPY config/ ./config/
COPY test/   ./test/
COPY Makefile setup.sh run.sh serve.sh discover.sh ./

# State dirs (persisted via volumes in docker-compose).
RUN mkdir -p reports profiles baselines history visual-baselines alerts-state sitemaps data defects

# Default port matches the rest of the system.
EXPOSE 8787
ENV NODE_ENV=production \
    QAAGENT_STORAGE=file \
    SANITY_HEADED=0

# Long-running daemon: webhook + version poller + dashboard.
CMD ["node", "src/serve.js", "--port", "8787", "--sites", "config/sites.json"]
