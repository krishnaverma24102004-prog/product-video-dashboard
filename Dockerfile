# One image: builds the React app, serves it from the Node backend on :4000.
# Build + run:  docker compose up --build   (or scripts/docker-start.ps1 / scripts/docker-start.sh)
FROM node:24-bookworm-slim AS web
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Playwright base image: Chromium + its system libraries. Its version must match backend/package-lock.json (1.64.0).
FROM mcr.microsoft.com/playwright:v1.64.0-noble
ENV NODE_ENV=production HEADLESS=true
WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev
COPY backend/ ./
COPY --from=web /app/frontend/dist /app/frontend/dist
EXPOSE 4000
# /api/health answers once the server is listening ("localhost" is in the default Host allowlist)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://localhost:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
