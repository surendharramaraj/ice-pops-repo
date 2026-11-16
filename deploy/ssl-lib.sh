# Shared SSL helpers for install-ssl.sh and use-server-cert.sh. Not run directly.
#
# Overridable for testing: NGINX_SITE, NGINX_DIRS, NGINX_T_FILE, SKIP_NGINX.

SITE="${NGINX_SITE:-/etc/nginx/sites-available/icepops}"
ENV_FILE="${ENV_FILE:-/etc/icepops/icepops.env}"

# The port the app listens on, from the settings file.
app_port() {
  local p
  p="$(grep -E '^PORT=[0-9]+$' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2 || true)"
  echo "${p:-8040}"
}
NGINX_DIRS="${NGINX_DIRS:-/etc/nginx/sites-enabled /etc/nginx/conf.d}"

die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

# The domain names a certificate covers: its subjectAltName list, or the CN on old certificates.
cert_names() {
  local names
  names="$(openssl x509 -in "$1" -noout -text | grep -o 'DNS:[^,[:space:]]*' | cut -d: -f2 | tr 'A-Z' 'a-z' || true)"
  [ -n "$names" ] || names="$(openssl x509 -in "$1" -noout -subject | sed -n 's/.*CN *= *\([^,/]*\).*/\1/p' | tr 'A-Z' 'a-z')"
  echo $names
}

# Exact match, or *.example.com covering exactly one more label (shop.example.com).
cert_covers() { # cert domain
  local want name
  want="$(printf '%s' "$2" | tr 'A-Z' 'a-z')"
  for name in $(cert_names "$1"); do
    [ "$name" = "$want" ] && return 0
    case "$name" in
      \*.*) [ "${want#*.}" = "${name#*.}" ] && [ "${want%%.*}" != "$want" ] && return 0 ;;
    esac
  done
  return 1
}

# Quietly true when the key belongs to the certificate.
key_matches() { # cert key
  local a b
  a="$(openssl x509 -in "$1" -noout -pubkey 2>/dev/null | openssl sha256)" || return 1
  b="$(openssl pkey -in "$2" -passin pass: -pubout 2>/dev/null | openssl sha256)" || return 1
  [ "$a" = "$b" ]
}

# Every check, with an explanation for each failure. Exits on a problem.
check_cert() { # cert key domain [chain]
  local cert="$1" key="$2" domain="$3" chain="${4:-}"
  [ -f "$cert" ] || die "Certificate file not found: $cert"
  [ -f "$key" ] || die "Key file not found: $key"
  openssl x509 -in "$cert" -noout 2>/dev/null || die "$cert isn't a PEM certificate. If you have a .pfx/.p12 file, convert it first:
  openssl pkcs12 -in cert.pfx -clcerts -nokeys -out certificate.crt
  openssl pkcs12 -in cert.pfx -nocerts -nodes -out private.key
If it's binary (DER): openssl x509 -inform der -in cert.cer -out certificate.crt"
  openssl pkey -in "$key" -passin pass: -noout 2>/dev/null || die "$key can't be read. If it has a passphrase, nginx can't use it; remove the passphrase with:
  openssl pkey -in $key -out private-nopass.key"
  key_matches "$cert" "$key" || die "The private key doesn't belong to this certificate. Check you have the matching pair."
  cert_covers "$cert" "$domain" || die "This certificate isn't valid for $domain. It covers: $(cert_names "$cert" | tr ' ' ',')"
  openssl x509 -in "$cert" -noout -checkend 0 >/dev/null || die "This certificate has expired ($(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2))."
  if ! openssl x509 -in "$cert" -noout -checkend $((30 * 86400)) >/dev/null; then
    echo "Warning: this certificate expires within 30 days, on $(openssl x509 -in "$cert" -noout -enddate | cut -d= -f2)."
  fi
  if [ -n "$chain" ]; then
    openssl x509 -in "$chain" -noout 2>/dev/null || die "$chain isn't a PEM certificate bundle."
  elif [ "$(grep -c 'BEGIN CERTIFICATE' "$cert")" -lt 2 ]; then
    echo "Note: no intermediate certificates found. If your CA sent a bundle (ca-bundle.crt or similar), include it, or some phones may show a warning."
  fi
}

# Stops if another nginx site already answers for this domain: two sites with
# the same server_name make nginx silently ignore one of them.
check_no_conflict() { # domain
  local domain="$1" hits pattern
  pattern="$(printf '%s' "$domain" | sed 's/[.]/[.]/g')"
  hits="$(grep -rlE "^[^#]*server_name[^;]*[[:space:]]$pattern([[:space:]]|;)" $NGINX_DIRS 2>/dev/null | while read -r f; do
    [ "$(readlink -f "$f" 2>/dev/null || echo "$f")" = "$(readlink -f "$SITE" 2>/dev/null || echo "$SITE")" ] || echo "$f"
  done || true)"
  [ -z "$hits" ] || die "Another nginx site already serves $domain:
  $(echo $hits)
Use a different domain for Icepops, such as icepops.$(echo "$domain" | sed 's/^[^.]*\.//') (your certificate must cover it),
or remove $domain from that site first."
}

# Writes the Icepops nginx site using the given certificate paths, tests it, and
# reloads nginx. Puts the previous site back if nginx rejects it.
write_ssl_site() { # domain cert_path key_path template
  local domain="$1" cert="$2" key="$3" template="$4"
  [ "${SKIP_NGINX:-}" = "1" ] || [ -f /etc/nginx/snippets/icepops-realip.conf ] || { mkdir -p /etc/nginx/snippets; : > /etc/nginx/snippets/icepops-realip.conf; }
  [ -f "$SITE" ] && cp "$SITE" "$SITE.before-ssl"
  sed -e "s|__DOMAIN__|$domain|g" -e "s|__CERT__|$cert|g" -e "s|__KEY__|$key|g" -e "s|__PORT__|$(app_port)|g" "$template" > "$SITE"
  if [ "${SKIP_NGINX:-}" = "1" ]; then echo "Site written (nginx skipped)."; return 0; fi
  ln -sf "$SITE" /etc/nginx/sites-enabled/icepops
  if ! nginx -t; then
    if [ -f "$SITE.before-ssl" ]; then mv "$SITE.before-ssl" "$SITE"; else rm -f "$SITE" /etc/nginx/sites-enabled/icepops; fi
    die "nginx rejected the new settings, so the previous ones were put back."
  fi
  systemctl reload nginx
  if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then ufw allow 'Nginx Full' >/dev/null; fi
}

# Certificate/key pairs nginx already uses, one "cert key" pair per line, from
# the full config (nginx -T), in the order they appear in each server block.
nginx_cert_pairs() {
  local dump
  if [ -n "${NGINX_T_FILE:-}" ]; then dump="$(cat "$NGINX_T_FILE")"; else dump="$(nginx -T 2>/dev/null)" || die "Couldn't read the nginx configuration (nginx -T)."; fi
  printf '%s\n' "$dump" | awk '
    function val(s) { s = $2; sub(/;.*/, "", s); gsub(/["\047]/, "", s); return s }
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*server[[:space:]]*\{/ { c = ""; k = ""; next }
    /^[[:space:]]*ssl_certificate_key[[:space:]]/ { k = val(); if (c != "") { print c, k; c = ""; k = "" } next }
    /^[[:space:]]*ssl_certificate[[:space:]]/     { c = val(); if (k != "") { print c, k; c = ""; k = "" } next }
  ' | awk '!seen[$0]++'
}
