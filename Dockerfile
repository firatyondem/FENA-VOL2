# The agent and its HTTP API, for an always-on host (fly.toml). Build from the repository root:
#   docker build -t fena-agent .
# The agent reads shared/ (asset profiles, deployments) and agent/config/, and keeps its log and SQLite database in
# DATA_DIR, a persistent volume. Keys come from the host's secret store, never from the image.
FROM node:24-slim

WORKDIR /app
COPY shared/ shared/
COPY agent/package.json agent/package-lock.json agent/
RUN cd agent && npm ci --omit=dev --no-audit --no-fund
COPY agent/ agent/

WORKDIR /app/agent
ENV NODE_ENV=production \
    AGENT_MODE=live \
    CONSOLE_HOST=0.0.0.0 \
    PORT=8080 \
    DATA_DIR=/data
EXPOSE 8080
# The supervisor restarts the agent after a crash, with backoff
CMD ["node", "scripts/supervise.ts"]
