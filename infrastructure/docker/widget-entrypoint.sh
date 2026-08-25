#!/bin/sh
# =============================================================================
# Substitute runtime URLs into the built widget assets.
#
# The loader and the panel are static files, but they need to know where the API and the realtime
# gateway live - and that differs per environment. Baking the values in at build time would mean a
# separate image per environment and no way to promote an artefact from staging to production.
#
# So the bundles ship with literal placeholders, and this replaces them once, at container start.
# nginx's own entrypoint runs everything in /docker-entrypoint.d before starting the server.
# =============================================================================
set -eu

ROOT="/usr/share/nginx/html"
API="${API_URL:-http://localhost:3001}"
REALTIME="${REALTIME_URL:-http://localhost:3002}"

# Trailing slashes are stripped so the bundles can concatenate paths without producing '//'.
API="${API%/}"
REALTIME="${REALTIME%/}"

echo "smartchat: pointing widget assets at API=${API} REALTIME=${REALTIME}"

replaced=0
for file in $(find "$ROOT" -type f \( -name '*.js' -o -name '*.html' \)); do
  if grep -q '__SMARTCHAT_' "$file" 2>/dev/null; then
    sed -i "s|__SMARTCHAT_API_URL__|${API}|g; s|__SMARTCHAT_REALTIME_URL__|${REALTIME}|g" "$file"
    replaced=$((replaced + 1))
  fi
done

echo "smartchat: substituted runtime URLs in ${replaced} file(s)"

# A build that produced no placeholders means the define step silently stopped working, which would
# leave the widget pointing at localhost in production. Fail loudly instead.
if [ "$replaced" -eq 0 ]; then
  echo "smartchat: ERROR - no placeholders found. The widget bundle was built incorrectly." >&2
  exit 1
fi
