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
# Files that already carry a substituted URL. A restarted container has these and no placeholders,
# which is correct rather than broken - see the guard below.
settled=0

for file in $(find "$ROOT" -type f \( -name '*.js' -o -name '*.html' \)); do
  if grep -q '__SMARTCHAT_' "$file" 2>/dev/null; then
    sed -i "s|__SMARTCHAT_API_URL__|${API}|g; s|__SMARTCHAT_REALTIME_URL__|${REALTIME}|g" "$file"
    replaced=$((replaced + 1))
  elif grep -q "${API}" "$file" 2>/dev/null; then
    settled=$((settled + 1))
  fi
done

echo "smartchat: substituted runtime URLs in ${replaced} file(s), ${settled} already done"

# -----------------------------------------------------------------------------
# The panel's Content Security Policy.
#
# It has to name the API and gateway origins, which are only known now, so the nginx config ships
# with a placeholder and gets it filled in here - the same trick, and the same reason, as the
# bundles above. STORAGE is the object store the browser fetches attachments from over signed URLs.
#
# The panel is framed on customer sites by design, so frame-ancestors stays open; every other
# directive is closed. connect-src is the one that matters: it is what stops a script that somehow
# got into this document from posting a transcript anywhere else.
# -----------------------------------------------------------------------------
STORAGE="${S3_PUBLIC_ENDPOINT:-}"
STORAGE="${STORAGE%/}"

api_host="${API#*://}"
realtime_host="${REALTIME#*://}"
case "$REALTIME" in
  https://*) realtime_ws="wss://${realtime_host}" ;;
  *)         realtime_ws="ws://${realtime_host}" ;;
esac
case "$API" in
  https://*) api_ws="wss://${api_host}" ;;
  *)         api_ws="ws://${api_host}" ;;
esac

connect_src="'self' ${API} ${api_ws} ${REALTIME} ${realtime_ws}"
img_src="'self' data: blob:"
if [ -n "$STORAGE" ]; then
  connect_src="${connect_src} ${STORAGE}"
  img_src="${img_src} ${STORAGE}"
fi

PANEL_CSP="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src ${img_src}; font-src 'self' data:; connect-src ${connect_src}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'"

# A literal '|' cannot appear in a URL host, so it is a safe sed delimiter here.
sed -i "s|__SMARTCHAT_PANEL_CSP__|${PANEL_CSP}|g" /etc/nginx/conf.d/default.conf
echo "smartchat: panel CSP set (connect-src ${connect_src})"

# The failure this guards against is a build whose define step silently stopped emitting
# placeholders, which would ship a widget pointing at localhost in production.
#
# "No placeholders" alone does not prove that. A container that is *restarted* rather than
# recreated keeps the filesystem it wrote on its first start, so the placeholders are gone and the
# real URLs are in their place - a healthy widget that this check used to kill on the second boot,
# taking the widget down until somebody recreated the container. So the error is only raised when
# there is neither a placeholder to substitute nor an already-substituted URL to find.
if [ "$replaced" -eq 0 ] && [ "$settled" -eq 0 ]; then
  echo "smartchat: ERROR - no placeholders and no substituted URLs found." >&2
  echo "smartchat: the widget bundle was built incorrectly; refusing to serve it." >&2
  exit 1
fi
