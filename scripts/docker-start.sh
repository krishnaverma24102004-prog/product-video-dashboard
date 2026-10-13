#!/usr/bin/env sh
# macOS/Linux: build and start the whole app in Docker.
# Usage (from the project root):  sh scripts/docker-start.sh
set -e
cd "$(dirname "$0")/.."

command -v docker >/dev/null 2>&1 || { echo "Docker is not installed: https://docs.docker.com/get-docker/"; exit 1; }
docker info >/dev/null 2>&1 || { echo "The Docker engine is not running. Start it and try again."; exit 1; }

if [ ! -f backend/.env ]; then
  cp backend/.env.example backend/.env
  echo "Created backend/.env from .env.example. Fill in GEMINI_API_KEY and IG_SESSION_ID, then run this again."
  exit 1
fi
mkdir -p backend/.sessions   # mounted into the container

docker compose up --build -d

echo "Waiting for the backend to report healthy..."
i=0
until curl -fs http://localhost:4000/api/health >/dev/null 2>&1 || [ $i -ge 60 ]; do i=$((i+1)); sleep 2; done
echo "Dashboard: http://localhost:4000   (logs: docker compose logs -f   stop: docker compose down)"
