#!/usr/bin/env bash
# Behind Cloudflare, every request reaches nginx from a Cloudflare address.
# This writes /etc/nginx/snippets/icepops-realip.conf so nginx takes the
# visitor's real IP from the CF-Connecting-IP header, trusting that header only
# from Cloudflare's published IP ranges (so nobody else can fake it).
# The Icepops nginx site includes the file; login rate limits and the app's
# own limits then work per visitor instead of per Cloudflare server.
#
# setup-server.sh runs this and installs it to run weekly, because Cloudflare
# occasionally adds ranges. By hand: sudo bash deploy/cloudflare-realip.sh

set -euo pipefail

SNIPPET="${SNIPPET:-/etc/nginx/snippets/icepops-realip.conf}"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

fetch() { curl -fsS --max-time 20 "$1"; }

V4="$(fetch https://www.cloudflare.com/ips-v4 || true)"
V6="$(fetch https://www.cloudflare.com/ips-v6 || true)"

# Keep only lines that look like IP ranges, so a broken download can't write junk into nginx.
V4="$(printf '%s\n' "$V4" | grep -E '^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$' || true)"
V6="$(printf '%s\n' "$V6" | grep -E '^[0-9a-fA-F:]+/[0-9]{1,3}$' || true)"

if [ "$(printf '%s\n' "$V4" | grep -c .)" -lt 5 ]; then
  echo "Couldn't download Cloudflare's IP ranges; keeping the current list." >&2
  [ -f "$SNIPPET" ] || : > "$SNIPPET"
  exit 0
fi

{
  echo "# Written by Icepops deploy/cloudflare-realip.sh on $(date -u +%F). Don't edit by hand."
  echo "# Requests from these Cloudflare ranges carry the visitor's IP in CF-Connecting-IP."
  printf '%s\n' "$V4" "$V6" | grep . | sed 's/^/set_real_ip_from /; s/$/;/'
  echo "real_ip_header CF-Connecting-IP;"
} > "$TMP"

mkdir -p "$(dirname "$SNIPPET")"
if [ -f "$SNIPPET" ] && cmp -s <(grep -v '^#' "$TMP") <(grep -v '^#' "$SNIPPET"); then
  echo "Cloudflare IP ranges unchanged."
  exit 0
fi

[ -f "$SNIPPET" ] && cp "$SNIPPET" "$SNIPPET.previous"
install -m 644 "$TMP" "$SNIPPET"
echo "Saved $(grep -c set_real_ip_from "$SNIPPET") Cloudflare IP ranges to $SNIPPET."

if [ "${SKIP_NGINX:-}" = "1" ]; then exit 0; fi
if nginx -t 2>/dev/null; then
  systemctl reload nginx
else
  [ -f "$SNIPPET.previous" ] && mv "$SNIPPET.previous" "$SNIPPET" || : > "$SNIPPET"
  echo "nginx rejected the new list, so the previous one was put back." >&2
  exit 1
fi
