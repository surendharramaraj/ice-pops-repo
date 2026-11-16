#!/usr/bin/env bash
# Installs an uploaded release into /opt/icepops and restarts the service.
# deploy.sh runs this on the server after uploading:
#
#   sudo bash /tmp/icepops-release/deploy/install-release.sh
#
# If another program already uses the app's port, it moves Icepops to a free
# port (8040 to 8099) and points nginx at it.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/.." && pwd)"
APP_DIR=/opt/icepops
ENV_FILE=/etc/icepops/icepops.env
SITE=/etc/nginx/sites-available/icepops

die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
port_busy() { ss -ltnH "sport = :$1" 2>/dev/null | grep -q .; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."
[ -f /etc/systemd/system/icepops.service ] || die "Run setup-server.sh first (deploy.sh --setup)."
[ -f "$ENV_FILE" ] || die "$ENV_FILE is missing. Run setup-server.sh first (deploy.sh --setup)."

echo "==> Copying the app to $APP_DIR"
rsync -a --delete --exclude node_modules --exclude data --exclude .DS_Store "$SRC/" "$APP_DIR/"
chown -R root:root "$APP_DIR"

echo "==> Installing packages"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund

echo "==> Checking the app's port"
systemctl stop icepops 2>/dev/null || true
PORT="$(grep -E '^PORT=[0-9]+$' "$ENV_FILE" | tail -1 | cut -d= -f2 || true)"
PORT="${PORT:-8040}"
if port_busy "$PORT"; then
  echo "Port $PORT is already used by another program:"
  ss -ltnpH "sport = :$PORT" | sed 's/^/    /'
  NEW=""
  for p in $(seq 8040 8099); do
    if ! port_busy "$p"; then NEW="$p"; break; fi
  done
  [ -n "$NEW" ] || die "No free port between 8040 and 8099. Set PORT in $ENV_FILE by hand."
  if grep -qE '^PORT=' "$ENV_FILE"; then
    sed -i -E "s/^PORT=.*/PORT=$NEW/" "$ENV_FILE"
  else
    echo "PORT=$NEW" >> "$ENV_FILE"
  fi
  PORT="$NEW"
  echo "Icepops will use port $PORT instead (saved in $ENV_FILE)."
else
  echo "Port $PORT is free."
fi

# nginx must forward to the same port the app listens on.
if [ -f "$SITE" ] && ! grep -qE "^[[:space:]]*server 127\.0\.0\.1:$PORT;" "$SITE"; then
  echo "==> Pointing nginx at port $PORT"
  cp "$SITE" "$SITE.before-port"
  sed -i -E "s/^([[:space:]]*server 127\.0\.0\.1:)[0-9]+;/\1$PORT;/" "$SITE"
  if nginx -t; then
    systemctl reload nginx
  else
    mv "$SITE.before-port" "$SITE"
    die "nginx rejected the change, so its settings were put back."
  fi
fi

echo "==> Starting Icepops"
systemctl start icepops

for i in $(seq 1 30); do
  # The health check answers "icepops ok", so another program on the port can't pass for it.
  if [ "$(curl -fsS -m 3 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)" = "icepops ok" ]; then
    echo "Icepops is up on port $PORT and connected to PostgreSQL."
    exit 0
  fi
  sleep 1
done

echo "Icepops didn't come up. Last log lines:" >&2
journalctl -u icepops -n 40 --no-pager >&2
exit 1
