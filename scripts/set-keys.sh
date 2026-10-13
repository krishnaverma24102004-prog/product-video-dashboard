#!/usr/bin/env sh
# Put a (new) Gemini API key and/or Instagram sessionid into backend/.env, then restart the Docker app.
# Values are read hidden. Press Enter to keep the current value.
# Usage (from the project root):  sh scripts/set-keys.sh
set -e
cd "$(dirname "$0")/.."
ENV=backend/.env
[ -f "$ENV" ] || cp backend/.env.example "$ENV"

set_value() { # name value
  if grep -q "^$1=" "$ENV"; then
    tmp=$(mktemp); awk -v k="$1" -v v="$2" 'BEGIN{FS=OFS="="} $1==k{print k"="v; next} {print}' "$ENV" > "$tmp" && mv "$tmp" "$ENV"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV"
  fi
}

printf 'New GEMINI_API_KEY (Enter = keep current): '; stty -echo; read -r G; stty echo; echo
[ -n "$G" ] && set_value GEMINI_API_KEY "$G" && echo "Gemini key saved."
printf 'New Instagram sessionid cookie (Enter = keep current): '; stty -echo; read -r S; stty echo; echo
[ -n "$S" ] && set_value IG_SESSION_ID "$S" && echo "Instagram session saved."

docker compose up -d --force-recreate && echo "Restarted. Dashboard: http://localhost:4000"
