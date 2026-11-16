# Deploying Icepops to your Ubuntu server

```
visitors ──HTTPS──▶ nginx (ports 80/443) ──▶ Icepops app (127.0.0.1:8000) ──▶ PostgreSQL (127.0.0.1:5432)
```

nginx handles HTTPS and forwards to the app. The app runs as a systemd service under its own `icepops` user, and keeps all data in the `icepops` database on your PostgreSQL.

## Before you start

- **Server:** Ubuntu 22.04 or 24.04 with PostgreSQL installed and running (`sudo systemctl status postgresql`).
- **SSH access:** you can SSH in from your Mac with a user that has `sudo`.
- **Domain:** a domain or subdomain, for example `icepops.example.com`, with its **A record pointing to the server's IP address**. HTTPS needs this.
- **Ports:** 80 and 443 are open in your cloud provider's firewall (security group). Ports 5432 and 8000 should stay closed to the internet.

## First deployment

From the `icepops` folder on your Mac:

```
deploy/deploy.sh ubuntu@YOUR_SERVER_IP --setup icepops.example.com you@example.com
```

This uploads the app, then on the server:

1. Installs nginx, certbot, and Node.js 22 (if Node 20 or newer isn't there already).
2. Creates the `icepops` system user, `/opt/icepops` for the app and `/etc/icepops/icepops.env` for settings.
3. Creates the `icepops` PostgreSQL login with a random password, and the `icepops` database ([deploy/postgres-setup.sql](deploy/postgres-setup.sql)). The password is written into the settings file.
4. Installs the systemd service ([deploy/icepops.service](deploy/icepops.service)) and the nginx site ([deploy/nginx-icepops.conf](deploy/nginx-icepops.conf)).
5. Gets a Let's Encrypt certificate and turns on the http-to-https redirect. Certificates renew automatically.
6. Installs packages, starts the app, and waits until `/healthz` confirms the app and database are up.

The app creates its tables the first time it starts. Then open `https://icepops.example.com/signup.html` and create your business.

## Updates

```
deploy/deploy.sh ubuntu@YOUR_SERVER_IP
```

This uploads the new code, installs packages and restarts. Database changes in `sql/` are applied automatically on start. Your local `data` folder is never uploaded.

## Settings

Edit `/etc/icepops/icepops.env` on the server, then `sudo systemctl restart icepops`. See [deploy/icepops.env.example](deploy/icepops.env.example) for every setting.

**Billing starts in test mode** (`BILLING_MODE=test`): anyone who signs up can switch on any plan without paying. Before you open sign-ups to the public, set up Razorpay (see README.md) and change to:

```
BILLING_MODE=razorpay
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=...
RAZORPAY_WEBHOOK_SECRET=...
```

The Razorpay webhook URL is `https://icepops.example.com/api/billing/webhook`.

## PostgreSQL on a different server

The setup skips the database step when the settings file already has a connection string. Before running `--setup`, create it on the app server:

```
sudo mkdir -p /etc/icepops
sudo cp /tmp/icepops-release/deploy/icepops.env.example /etc/icepops/icepops.env   # after one upload, or copy it over by hand
sudo nano /etc/icepops/icepops.env
#   DATABASE_URL=postgres://icepops:PASSWORD@10.0.0.5:5432/icepops
```

Create that role and database on the database server with `deploy/postgres-setup.sql`, allow the app server's IP in its `pg_hba.conf`, and set `listen_addresses` in `postgresql.conf`. The app connects with SSL to non-local databases. Add `PGSSL=off` if your server has no SSL, or `PGSSL=verify` to check its certificate.

## Moving your old spreadsheet data in

After signing up on the server:

```
scp data/icepops-data.xlsx ubuntu@YOUR_SERVER_IP:/tmp/
ssh ubuntu@YOUR_SERVER_IP
chmod 644 /tmp/icepops-data.xlsx
sudo -u icepops bash -c 'set -a; . /etc/icepops/icepops.env; cd /opt/icepops; node scripts/import-excel.js /tmp/icepops-data.xlsx you@example.com'
rm /tmp/icepops-data.xlsx
```

## Everyday commands (on the server)

| What | Command |
| --- | --- |
| Is it running? | `sudo systemctl status icepops` |
| Live logs | `sudo journalctl -u icepops -f` |
| Restart | `sudo systemctl restart icepops` |
| Health check | `curl http://127.0.0.1:8000/healthz` |
| nginx logs | `sudo tail -f /var/log/nginx/error.log` |
| Test nginx config | `sudo nginx -t` |

## Backups

All your customers' data is in the `icepops` database. Back it up every night, and copy the backups off the server:

```
sudo -u postgres pg_dump -Fc icepops > /var/backups/icepops-$(date +%F).dump
```

To restore into an empty database: `sudo -u postgres pg_restore -d icepops /var/backups/icepops-YYYY-MM-DD.dump`.

A nightly cron job for this, as root (`sudo crontab -e`):

```
30 2 * * * sudo -u postgres pg_dump -Fc icepops > /var/backups/icepops-$(date +\%F).dump && find /var/backups -name 'icepops-*.dump' -mtime +14 -delete
```
