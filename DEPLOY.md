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

From the `icepops` folder on your Mac, using **the SSL certificate nginx on your server already has**:

```
deploy/deploy.sh ubuntu@YOUR_SERVER_IP --setup icepops.seyinfotechnology.com --use-server-cert
```

Your domain is behind Cloudflare, so read the [Cloudflare section](#cloudflare-icepopsseyinfotechnologycom) first.

Or uploading **certificate files from your Mac**:

```
deploy/deploy.sh ubuntu@YOUR_SERVER_IP --setup icepops.example.com \
  --cert ~/ssl/certificate.crt --key ~/ssl/private.key --chain ~/ssl/ca-bundle.crt
```

Or with a **free Let's Encrypt certificate** instead:

```
deploy/deploy.sh ubuntu@YOUR_SERVER_IP --setup icepops.example.com --email you@example.com
```

This uploads the app, then on the server:

1. Installs nginx, certbot, and Node.js 22 (if Node 20 or newer isn't there already).
2. Creates the `icepops` system user, `/opt/icepops` for the app and `/etc/icepops/icepops.env` for settings.
3. Creates the `icepops` PostgreSQL login with a random password, and the `icepops` database ([deploy/postgres-setup.sql](deploy/postgres-setup.sql)). The password is written into the settings file.
4. Installs the systemd service ([deploy/icepops.service](deploy/icepops.service)) and the nginx site ([deploy/nginx-icepops.conf](deploy/nginx-icepops.conf)).
5. Turns on HTTPS with the http-to-https redirect: installs your certificate, or gets a Let's Encrypt one (which renews automatically).
6. Installs packages, starts the app, and waits until `/healthz` confirms the app and database are up.

The app creates its tables the first time it starts. Then open `https://icepops.example.com/signup.html` and create your business.

## Updates

```
deploy/deploy.sh ubuntu@YOUR_SERVER_IP
```

This uploads the new code, installs packages and restarts. Database changes in `sql/` are applied automatically on start. Your local `data` folder is never uploaded.

## Cloudflare (icepops.seyinfotechnology.com)

`icepops.seyinfotechnology.com` is proxied through Cloudflare (the orange cloud), so visitors connect to Cloudflare and Cloudflare connects to your server.

**In the Cloudflare dashboard for seyinfotechnology.com:**

1. **DNS:** the `icepops` A record must point to your Ubuntu server's public IP, with the proxy on (orange cloud).
2. **SSL/TLS → Overview:** set the encryption mode to **Full (strict)**.
   - Don't use **Flexible**. Cloudflare would then talk to your server over plain http, nginx redirects http to https, and the site loops forever.
3. **Caching:** leave it on the defaults, and don't add a "Cache Everything" rule for this hostname. The app marks every response as not cacheable, so customers always see current stock and bills.
4. **Speed → Optimization:** if pages ever load but buttons do nothing, turn **Rocket Loader** off for this hostname, because it changes how scripts load.
5. **Security:** the Razorpay webhook (`https://icepops.seyinfotechnology.com/api/billing/webhook`) must reach the server. If Bot Fight Mode or a WAF rule blocks it, add a skip rule for that path.

**The certificate on your server** has to be one Cloudflare accepts in Full (strict) mode. Pick one:

- **Your existing nginx certificate,** if it covers `icepops.seyinfotechnology.com`, which a wildcard `*.seyinfotechnology.com` does:
  ```
  deploy/deploy.sh ubuntu@YOUR_SERVER_IP --setup icepops.seyinfotechnology.com --use-server-cert
  ```
- **A free Cloudflare Origin Certificate** (valid up to 15 years, trusted by Cloudflare only, which is all that's needed behind the proxy). Create it under SSL/TLS → Origin Server → Create Certificate, for `*.seyinfotechnology.com` and `seyinfotechnology.com`, in PEM format. Save the certificate as `origin.pem` and the private key as `origin.key`, then:
  ```
  deploy/deploy.sh ubuntu@YOUR_SERVER_IP --setup icepops.seyinfotechnology.com --cert origin.pem --key origin.key
  ```
  The "no intermediate certificates" note is expected for origin certificates; ignore it.
- **Let's Encrypt** (`--email`) can fail behind Cloudflare when "Always Use HTTPS" is on, so prefer one of the two above.

**Visitor IPs:** behind Cloudflare, every request reaches nginx from a Cloudflare address. The setup installs [deploy/cloudflare-realip.sh](deploy/cloudflare-realip.sh), which lists Cloudflare's IP ranges so nginx takes the real visitor IP from the `CF-Connecting-IP` header. It trusts that header only from Cloudflare's addresses, so it can't be faked. Without it, the login rate limit would treat many customers as one visitor. The list refreshes weekly (`/etc/cron.weekly/icepops-cloudflare-realip`).

**Optional, extra safety:** allow ports 80 and 443 only from Cloudflare's IP ranges in your server or cloud firewall, so nobody can bypass Cloudflare by using the server's IP directly.

## Using the certificate your nginx already has

If nginx on the server already serves another site over HTTPS, Icepops can use the same certificate files where they are:

```
deploy/deploy.sh ubuntu@YOUR_SERVER_IP --setup icepops.yourdomain.com --use-server-cert
```

[deploy/use-server-cert.sh](deploy/use-server-cert.sh) reads your nginx configuration (`nginx -T`), lists every certificate it uses, and picks the first one that covers your Icepops domain and has a matching key. It then runs the usual checks and points the Icepops site at those files. Nothing is copied, so when the certificate is renewed (by you, or by certbot for `/etc/letsencrypt` certificates) Icepops uses the new one after the next nginx reload.

To name the files yourself (find them with `sudo grep -rn ssl_certificate /etc/nginx/`):

```
deploy/deploy.sh ubuntu@YOUR_SERVER_IP --setup icepops.yourdomain.com \
  --server-cert /etc/ssl/certs/yourdomain.crt --server-key /etc/ssl/private/yourdomain.key
```

**Which domain to use:**

- **Your certificate must cover it.** A wildcard certificate (`*.yourdomain.com`) covers any subdomain such as `icepops.yourdomain.com`. A certificate for `yourdomain.com` and `www.yourdomain.com` only covers those two names.
- **It can't be a domain your existing site already serves.** Two nginx sites with the same domain make nginx silently ignore one of them, so the script stops and names the site that uses it.
- **The usual answer is a subdomain** such as `icepops.yourdomain.com`, with a wildcard certificate (or one that lists that name), and a DNS A record pointing the subdomain at the server.

## Uploading your own SSL certificate

You need three files from your certificate provider, in PEM format (text files starting with `-----BEGIN`):

| Option | File | Often called |
| --- | --- | --- |
| `--cert` | Your domain's certificate | `certificate.crt`, `your_domain.crt` |
| `--key` | The private key you made with the certificate request, without a passphrase | `private.key`, `your_domain.key` |
| `--chain` | The CA's intermediate certificates (optional, but include it if you have it) | `ca-bundle.crt`, `ca_bundle.crt`, `intermediate.crt` |

Before anything changes, `deploy/install-ssl.sh` checks:

- that the key belongs to the certificate;
- that the certificate covers your domain (wildcards like `*.example.com` count);
- that it hasn't expired, with a warning if it expires within 30 days.

It then joins the certificate and bundle into `/etc/icepops/ssl/fullchain.pem`, stores the key as `/etc/icepops/ssl/privkey.pem` (readable only by root), and switches nginx to [deploy/nginx-icepops-ssl.conf](deploy/nginx-icepops-ssl.conf). If nginx rejects the result, the previous settings are put back. The uploaded copies are deleted from the server afterwards.

**Renewing:** your own certificate doesn't renew automatically. When you get the new files, run:

```
deploy/deploy.sh ubuntu@YOUR_SERVER_IP --cert new.crt --key new.key --chain ca-bundle.crt
```

**Other formats:**

- **A `.pfx` / `.p12` file:** split it first with `openssl pkcs12 -in cert.pfx -clcerts -nokeys -out certificate.crt` and `openssl pkcs12 -in cert.pfx -nocerts -nodes -out private.key`.
- **A key with a passphrase:** remove the passphrase with `openssl pkey -in private.key -out private-nopass.key`.

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
