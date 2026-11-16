#!/usr/bin/env bash
# Installs certificate files you upload for Icepops and switches nginx to them.
# deploy.sh runs this when you pass --cert and --key. On the server by hand:
#
#   sudo bash deploy/install-ssl.sh icepops.example.com certificate.crt private.key [ca-bundle.crt]
#
# certificate.crt  your domain's certificate (PEM, starts with -----BEGIN CERTIFICATE-----)
# private.key      its private key, without a passphrase
# ca-bundle.crt    optional: the CA's intermediate certificates, if they came separately
#
# Leave the domain empty ("") to keep the one nginx already uses. Run it again
# with the new files whenever you renew the certificate.
# (If nginx on this server already has the certificate, use use-server-cert.sh instead.)

set -euo pipefail

DOMAIN="${1:-}"
CERT="${2:-}"
KEY="${3:-}"
CHAIN="${4:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SSL_DIR="${SSL_DIR:-/etc/icepops/ssl}"
. "$HERE/ssl-lib.sh"

[ "${SKIP_ROOT_CHECK:-}" = "1" ] || [ "$(id -u)" -eq 0 ] || die "Run this with sudo."
[ -n "$CERT" ] && [ -n "$KEY" ] || die "Usage: sudo bash deploy/install-ssl.sh DOMAIN CERTIFICATE KEY [CA_BUNDLE]"
[ -z "$CHAIN" ] || [ -f "$CHAIN" ] || die "CA bundle file not found: $CHAIN"

if [ -z "$DOMAIN" ] && [ -f "$SITE" ]; then
  DOMAIN="$(grep -m1 -E '^\s*server_name' "$SITE" | awk '{print $2}' | tr -d ';')"
fi
[ -n "$DOMAIN" ] || die "Give the domain the certificate is for."

echo "==> Checking the certificate for $DOMAIN"
check_cert "$CERT" "$KEY" "$DOMAIN" "$CHAIN"
check_no_conflict "$DOMAIN"

echo "==> Installing it"
install -d -m 700 -o root -g root "$SSL_DIR" 2>/dev/null || mkdir -p "$SSL_DIR"
# nginx wants your certificate first, then the intermediates, in one file.
{ cat "$CERT"; echo; [ -z "$CHAIN" ] || cat "$CHAIN"; } | sed '/^$/d' > "$SSL_DIR/fullchain.pem.new"
openssl pkey -in "$KEY" -out "$SSL_DIR/privkey.pem.new"
chmod 644 "$SSL_DIR/fullchain.pem.new"
chmod 600 "$SSL_DIR/privkey.pem.new"
mv "$SSL_DIR/fullchain.pem.new" "$SSL_DIR/fullchain.pem"
mv "$SSL_DIR/privkey.pem.new" "$SSL_DIR/privkey.pem"

echo "==> Switching nginx to your certificate"
write_ssl_site "$DOMAIN" "$SSL_DIR/fullchain.pem" "$SSL_DIR/privkey.pem" "$HERE/nginx-icepops-ssl.conf"

echo "HTTPS is on for $DOMAIN with your certificate, valid until $(openssl x509 -in "$SSL_DIR/fullchain.pem" -noout -enddate | cut -d= -f2)."
echo "When you renew it, run this again with the new files."
