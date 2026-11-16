#!/usr/bin/env bash
# Installs an uploaded release into /opt/icepops and restarts the service.
# deploy.sh runs this on the server after uploading:
#
#   sudo bash /tmp/icepops-release/deploy/install-release.sh

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
APP_DIR=/opt/icepops
PORT="$(grep -E '^PORT=' /etc/icepops/icepops.env 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-8000}"

[ "$(id -u)" -eq 0 ] || { echo "Run this with sudo." >&2; exit 1; }
[ -f /etc/systemd/system/icepops.service ] || { echo "Run setup-server.sh first (deploy.sh --setup)." >&2; exit 1; }

echo "==> Copying the app to $APP_DIR"
rsync -a --delete --exclude node_modules --exclude data --exclude .DS_Store "$SRC/" "$APP_DIR/"
chown -R root:root "$APP_DIR"

echo "==> Installing packages"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

echo "==> Restarting Icepops"
systemctl restart icepops

for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "Icepops is up and connected to PostgreSQL."
    exit 0
  fi
  sleep 1
done

echo "Icepops didn't come up. Last log lines:" >&2
journalctl -u icepops -n 40 --no-pager >&2
exit 1
