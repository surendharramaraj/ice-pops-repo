#!/usr/bin/env bash
# Uses an SSL certificate that nginx on this server already has, for Icepops.
# The files stay where they are, so when that certificate is renewed (by you,
# or by certbot for /etc/letsencrypt), Icepops picks up the new one on the next
# nginx reload. deploy.sh runs this for --use-server-cert. On the server by hand:
#
#   sudo bash deploy/use-server-cert.sh icepops.example.com
#       finds a certificate in your nginx configuration that covers the domain
#
#   sudo bash deploy/use-server-cert.sh icepops.example.com /etc/ssl/certs/mydomain.crt /etc/ssl/private/mydomain.key
#       uses these exact files

set -euo pipefail

DOMAIN="${1:-}"
CERT="${2:-}"
KEY="${3:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$HERE/ssl-lib.sh"

[ "${SKIP_ROOT_CHECK:-}" = "1" ] || [ "$(id -u)" -eq 0 ] || die "Run this with sudo."
[ -n "$DOMAIN" ] || die "Usage: sudo bash deploy/use-server-cert.sh DOMAIN [CERTIFICATE_PATH KEY_PATH]"
[ -z "$CERT" ] || [ -n "$KEY" ] || die "Give both the certificate path and the key path, or neither."

if [ -z "$CERT" ]; then
  echo "==> Looking for a certificate in your nginx configuration that covers $DOMAIN"
  PAIRS="$(nginx_cert_pairs)"
  [ -n "$PAIRS" ] || die "Your nginx configuration has no ssl_certificate lines. Give the certificate and key paths instead."
  while read -r c k; do
    [ -f "$c" ] && [ -f "$k" ] || continue
    case "$c" in /etc/icepops/*) continue ;; esac   # not our own earlier copy
    echo "    found $c"
    if cert_covers "$c" "$DOMAIN" && key_matches "$c" "$k"; then CERT="$c"; KEY="$k"; break; fi
    echo "      (doesn't cover $DOMAIN: $(cert_names "$c" | tr ' ' ','))"
  done <<< "$PAIRS"
  [ -n "$CERT" ] || die "None of the certificates nginx uses covers $DOMAIN.
Use a domain one of them covers, give the certificate paths by hand, or upload one with --cert/--key."
fi

echo "==> Checking $CERT"
check_cert "$CERT" "$KEY" "$DOMAIN"
check_no_conflict "$DOMAIN"

echo "==> Pointing Icepops at it"
write_ssl_site "$DOMAIN" "$CERT" "$KEY" "$HERE/nginx-icepops-ssl.conf"

echo "HTTPS is on for $DOMAIN using $CERT, valid until $(openssl x509 -in "$CERT" -noout -enddate | cut -d= -f2)."
case "$CERT" in
  /etc/letsencrypt/*) echo "certbot renews it and reloads nginx, so nothing more to do." ;;
  *) echo "When you renew this certificate in place, reload nginx (sudo systemctl reload nginx) and Icepops uses the new one too." ;;
esac
