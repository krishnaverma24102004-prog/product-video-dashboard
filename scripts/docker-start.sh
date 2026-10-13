#!/usr/bin/env sh
# macOS/Linux: start the whole app in Docker. Asks for the Gemini key / Instagram session ONLY if they are not
# saved yet; after the first run they stay in backend/.env (gitignored, never in the image) and are reused.
# Usage (from the project root):  sh scripts/docker-start.sh
# To replace a saved key later:   sh scripts/set-keys.sh
set -e
cd "$(dirname "$0")/.."

command -v docker >/dev/null 2>&1 || { echo "Docker is not installed: https://docs.docker.com/get-docker/"; exit 1; }
docker info >/dev/null 2>&1 || { echo "The Docker engine is not running. Start it and try again."; exit 1; }

ENV=backend/.env
[ -f "$ENV" ] || cp backend/.env.example "$ENV"
get_value() { sed -n "s/^$1=//p" "$ENV" | head -n1 | tr -d '[:space:]'; }
set_value() {
  if grep -q "^$1=" "$ENV"; then
    tmp=$(mktemp); awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$ENV" > "$tmp" && mv "$tmp" "$ENV"
  else printf '%s=%s\n' "$1" "$2" >> "$ENV"; fi
}
# prompt on stderr so only the typed value is captured by $(...)
ask() { printf '%s: ' "$1" >&2; stty -echo; read -r v; stty echo; echo >&2; printf '%s' "$v"; }

if [ -z "$(get_value GEMINI_API_KEY)" ]; then
  echo "First run: a free Gemini key is needed (https://aistudio.google.com/apikey)."
  G=$(ask "GEMINI_API_KEY (hidden; Enter = skip)"); [ -n "$G" ] && set_value GEMINI_API_KEY "$G" && echo "Saved; reused on every start."
else echo "Gemini key: saved (reusing)."; fi
if [ -z "$(get_value IG_SESSION_ID)" ] && [ ! -f backend/.sessions/ig.json ]; then
  echo "First run: Instagram needs your sessionid cookie (DevTools > Application > Cookies > instagram.com)."
  S=$(ask "IG_SESSION_ID (hidden; Enter = skip)"); [ -n "$S" ] && set_value IG_SESSION_ID "$S" && echo "Saved; reused on every start."
else echo "Instagram session: saved (reusing)."; fi

mkdir -p backend/.sessions   # mounted into the container
docker compose up -d --build

echo "Waiting for the backend to report healthy..."
i=0
until curl -fs http://localhost:4000/api/health >/dev/null 2>&1 || [ $i -ge 60 ]; do i=$((i+1)); sleep 2; done
echo "Dashboard: http://localhost:4000   (logs: docker compose logs -f   stop: docker compose down)"
