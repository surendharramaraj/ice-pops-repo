#!/usr/bin/env bash
# Deploys Icepops from this computer to your Ubuntu server over SSH.
#
# First time (sets up nginx, Node, PostgreSQL login, systemd and HTTPS):
#   deploy/deploy.sh ubuntu@203.0.113.10 --setup icepops.example.com you@example.com
#
# Every update after that:
#   deploy/deploy.sh ubuntu@203.0.113.10
#
# Your SSH user needs sudo on the server; you'll be asked for its password.

set -euo pipefail

TARGET="${1:-}"
[ -n "$TARGET" ] || { sed -n '2,11p' "$0"; exit 1; }
shift
SETUP=0
if [ "${1:-}" = "--setup" ]; then
  SETUP=1
  DOMAIN="${2:-}"
  EMAIL="${3:-}"
  [ -n "$DOMAIN" ] || { echo "--setup needs your domain, for example: --setup icepops.example.com you@example.com" >&2; exit 1; }
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE=/tmp/icepops-release

echo "==> Uploading to $TARGET:$RELEASE"
# Your local data (data/, including old spreadsheets) is never uploaded.
rsync -az --delete \
  --exclude node_modules --exclude data --exclude .DS_Store --exclude '*.log' \
  "$ROOT/" "$TARGET:$RELEASE/"

if [ "$SETUP" -eq 1 ]; then
  ssh -t "$TARGET" "sudo bash $RELEASE/deploy/setup-server.sh '$DOMAIN' '$EMAIL'"
fi
ssh -t "$TARGET" "sudo bash $RELEASE/deploy/install-release.sh"

echo
echo "Deployed. Logs: ssh $TARGET 'sudo journalctl -u icepops -f'"
