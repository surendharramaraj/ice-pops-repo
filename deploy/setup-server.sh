#!/usr/bin/env bash
# One-time setup of an Ubuntu server for Icepops. Run it as root from the
# uploaded release (deploy.sh --setup does this for you):
#
#   sudo bash deploy/setup-server.sh icepops.example.com you@example.com
#   sudo bash deploy/setup-server.sh icepops.example.com "" --own-cert
#
# It installs nginx, Node.js 22 and certbot; creates the icepops system user,
# the PostgreSQL role and database, the settings file, the systemd service and
# the nginx site; then asks Let's Encrypt for an HTTPS certificate, unless
# --own-cert says you'll install your own with install-ssl.sh.
# Safe to run again: existing settings and the database password are kept.

set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
OWN_CERT=0
[ "${3:-}" = "--own-cert" ] && OWN_CERT=1
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR=/opt/icepops
ENV_DIR=/etc/icepops
ENV_FILE="$ENV_DIR/icepops.env"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run this with sudo."
[ -n "$DOMAIN" ] || die "Give your domain, for example: sudo bash deploy/setup-server.sh icepops.example.com you@example.com"
grep -qi ubuntu /etc/os-release || echo "Warning: this script is written for Ubuntu."

say "Installing nginx, certbot and tools"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx certbot python3-certbot-nginx curl ca-certificates rsync openssl

NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [ "$NODE_MAJOR" -lt 20 ]; then
  say "Installing Node.js 22 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  bash /tmp/nodesource_setup.sh
  apt-get install -y nodejs
fi
echo "Node $(node -v), npm $(npm -v)"

say "Creating the icepops user and folders"
id icepops >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin icepops
install -d -m 755 -o root -g root "$APP_DIR"
install -d -m 750 -o root -g icepops "$ENV_DIR"

if [ -f "$ENV_FILE" ] && grep -q '^DATABASE_URL=' "$ENV_FILE" && ! grep -q 'CHANGE_ME' "$ENV_FILE"; then
  # Already set up, or pointed at PostgreSQL on another server by hand.
  echo "$ENV_FILE already has a database connection; keeping it."
else
  say "Creating the icepops database and login on this server's PostgreSQL"
  command -v psql >/dev/null 2>&1 || die "PostgreSQL isn't installed here. Install it (sudo apt install postgresql), or put DATABASE_URL for your database server in $ENV_FILE and run this again."
  systemctl is-active --quiet postgresql || die "PostgreSQL isn't running. Start it with: sudo systemctl start postgresql"
  DB_PASSWORD="$(openssl rand -hex 24)"
  sudo -u postgres psql -v db_password="$DB_PASSWORD" -f "$HERE/postgres-setup.sql"
  [ -f "$ENV_FILE" ] || cp "$HERE/icepops.env.example" "$ENV_FILE"
  sed -i "s#^DATABASE_URL=.*#DATABASE_URL=postgres://icepops:${DB_PASSWORD}@127.0.0.1:5432/icepops#" "$ENV_FILE"
  echo "Database password saved in $ENV_FILE"
fi
chown root:icepops "$ENV_FILE"
chmod 640 "$ENV_FILE"

say "Installing the systemd service"
install -m 644 "$HERE/icepops.service" /etc/systemd/system/icepops.service
systemctl daemon-reload
systemctl enable icepops

say "Trusting visitor IPs from Cloudflare"
mkdir -p /etc/nginx/snippets
SKIP_NGINX=1 bash "$HERE/cloudflare-realip.sh" || true
[ -f /etc/nginx/snippets/icepops-realip.conf ] || : > /etc/nginx/snippets/icepops-realip.conf
install -m 755 "$HERE/cloudflare-realip.sh" /usr/local/sbin/icepops-cloudflare-realip
printf '#!/bin/sh\n# Keeps the Cloudflare IP ranges nginx trusts up to date (Icepops).\n/usr/local/sbin/icepops-cloudflare-realip >/dev/null\n' > /etc/cron.weekly/icepops-cloudflare-realip
chmod 755 /etc/cron.weekly/icepops-cloudflare-realip

if [ "$OWN_CERT" -eq 1 ] && grep -qs "listen 443" /etc/nginx/sites-available/icepops; then
  echo "nginx already serves Icepops over HTTPS; leaving its settings alone."
else
  say "Setting up nginx for $DOMAIN"
  ( . "$HERE/ssl-lib.sh"; check_no_conflict "$DOMAIN" )
  APP_PORT="$( . "$HERE/ssl-lib.sh"; app_port )"
  sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$APP_PORT/g" "$HERE/nginx-icepops.conf" > /etc/nginx/sites-available/icepops
  ln -sf /etc/nginx/sites-available/icepops /etc/nginx/sites-enabled/icepops
  nginx -t
  systemctl reload nginx
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  say "Opening ports 80 and 443 in the firewall"
  ufw allow 'Nginx Full'
fi

if [ "$OWN_CERT" -eq 1 ]; then
  echo "Using your own SSL certificate (set up in the next step), so Let's Encrypt is skipped."
elif [ -n "$EMAIL" ]; then
  say "Getting an HTTPS certificate from Let's Encrypt"
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect; then
    echo "HTTPS is on. Certificates renew automatically."
  else
    echo "Couldn't get a certificate yet. Check that $DOMAIN points to this server's IP address, then run:"
    echo "  sudo certbot --nginx -d $DOMAIN -m $EMAIL --agree-tos --redirect"
  fi
else
  echo "No email given, so HTTPS was skipped. When $DOMAIN points here, run:"
  echo "  sudo certbot --nginx -d $DOMAIN -m you@example.com --agree-tos --redirect"
fi

say "Server setup done. Settings: $ENV_FILE"
