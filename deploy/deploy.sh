#!/usr/bin/env bash
# Deploys Icepops from this computer to your Ubuntu server over SSH.
#
# First time, with a free Let's Encrypt certificate:
#   deploy/deploy.sh ubuntu@203.0.113.10 --setup icepops.example.com --email you@example.com
#
# First time, with the SSL certificate nginx on the server already uses
# (found automatically, or give its paths on the server):
#   deploy/deploy.sh ubuntu@203.0.113.10 --setup icepops.example.com --use-server-cert
#   deploy/deploy.sh ubuntu@203.0.113.10 --setup icepops.example.com \
#     --server-cert /etc/ssl/certs/mydomain.crt --server-key /etc/ssl/private/mydomain.key
#
# First time, uploading certificate files from this computer:
#   deploy/deploy.sh ubuntu@203.0.113.10 --setup icepops.example.com \
#     --cert ~/ssl/certificate.crt --key ~/ssl/private.key [--chain ~/ssl/ca-bundle.crt]
#
# Every update after that:
#   deploy/deploy.sh ubuntu@203.0.113.10
#
# Renewing your own certificate (with or without an update):
#   deploy/deploy.sh ubuntu@203.0.113.10 --cert new.crt --key new.key [--chain ca-bundle.crt]
#
# Your SSH user needs sudo on the server; you'll be asked for its password.

set -euo pipefail

usage() { sed -n '2,26p' "$0"; exit 1; }

TARGET="${1:-}"
[ -n "$TARGET" ] && [ "${TARGET#-}" = "$TARGET" ] || usage
shift

DOMAIN="" EMAIL="" CERT="" KEY="" CHAIN="" SETUP=0 USE_SERVER=0 SERVER_CERT="" SERVER_KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --setup) SETUP=1; DOMAIN="${2:-}"; shift 2 || usage ;;
    --email) EMAIL="${2:-}"; shift 2 || usage ;;
    --cert)  CERT="${2:-}"; shift 2 || usage ;;
    --key)   KEY="${2:-}"; shift 2 || usage ;;
    --chain) CHAIN="${2:-}"; shift 2 || usage ;;
    --use-server-cert) USE_SERVER=1; shift ;;
    --server-cert) USE_SERVER=1; SERVER_CERT="${2:-}"; shift 2 || usage ;;
    --server-key)  USE_SERVER=1; SERVER_KEY="${2:-}"; shift 2 || usage ;;
    *) # Older form: --setup DOMAIN EMAIL
       if [ "$SETUP" -eq 1 ] && [ -z "$EMAIL" ]; then EMAIL="$1"; shift; else echo "Unknown option: $1" >&2; usage; fi ;;
  esac
done

[ "$SETUP" -eq 0 ] || [ -n "$DOMAIN" ] || { echo "--setup needs your domain, for example: --setup icepops.example.com" >&2; exit 1; }
if [ "$USE_SERVER" -eq 1 ]; then
  [ -z "$CERT$KEY$CHAIN" ] || { echo "Use either the server's certificate or --cert/--key files, not both." >&2; exit 1; }
  [ -z "$SERVER_CERT$SERVER_KEY" ] || { [ -n "$SERVER_CERT" ] && [ -n "$SERVER_KEY" ]; } || { echo "Give both --server-cert and --server-key." >&2; exit 1; }
  [ -n "$DOMAIN" ] || { echo "Using the server's certificate needs your domain: add --setup icepops.example.com" >&2; exit 1; }
fi
if [ -n "$CERT$KEY$CHAIN" ]; then
  [ -n "$CERT" ] && [ -n "$KEY" ] || { echo "Give both --cert and --key." >&2; exit 1; }
  for f in "$CERT" "$KEY" ${CHAIN:+"$CHAIN"}; do [ -f "$f" ] || { echo "File not found: $f" >&2; exit 1; }; done
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE=/tmp/icepops-release
SSL_UPLOAD=/tmp/icepops-ssl-upload

echo "==> Uploading to $TARGET:$RELEASE"
# Your local data (data/, including old spreadsheets) is never uploaded.
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .DS_Store --exclude '*.log' \
  "$ROOT/" "$TARGET:$RELEASE/"

SSL_ARGS=""
if [ -n "$CERT" ]; then
  echo "==> Uploading your certificate files"
  ssh "$TARGET" "rm -rf $SSL_UPLOAD && mkdir -m 700 $SSL_UPLOAD"
  rsync -a --chmod=F600 "$CERT" "$TARGET:$SSL_UPLOAD/certificate.crt"
  rsync -a --chmod=F600 "$KEY" "$TARGET:$SSL_UPLOAD/private.key"
  [ -z "$CHAIN" ] || rsync -a --chmod=F600 "$CHAIN" "$TARGET:$SSL_UPLOAD/ca-bundle.crt"
  SSL_ARGS="'$DOMAIN' $SSL_UPLOAD/certificate.crt $SSL_UPLOAD/private.key"
  [ -z "$CHAIN" ] || SSL_ARGS="$SSL_ARGS $SSL_UPLOAD/ca-bundle.crt"
fi

if [ "$SETUP" -eq 1 ]; then
  if [ -n "$CERT" ] || [ "$USE_SERVER" -eq 1 ]; then
    ssh -t "$TARGET" "sudo bash $RELEASE/deploy/setup-server.sh '$DOMAIN' '' --own-cert"
  else
    ssh -t "$TARGET" "sudo bash $RELEASE/deploy/setup-server.sh '$DOMAIN' '$EMAIL'"
  fi
fi

if [ -n "$CERT" ]; then
  # The uploaded copies (including the private key) are deleted whether or not it worked.
  ssh -t "$TARGET" "sudo bash $RELEASE/deploy/install-ssl.sh $SSL_ARGS; status=\$?; rm -rf $SSL_UPLOAD; exit \$status"
fi

if [ "$USE_SERVER" -eq 1 ]; then
  ssh -t "$TARGET" "sudo bash $RELEASE/deploy/use-server-cert.sh '$DOMAIN' '$SERVER_CERT' '$SERVER_KEY'"
fi

ssh -t "$TARGET" "sudo bash $RELEASE/deploy/install-release.sh"

echo
echo "Deployed. Logs: ssh $TARGET 'sudo journalctl -u icepops -f'"
