#!/usr/bin/env bash
# Generate a self-signed TLS cert for Boardfish 5 covering all local names.
#
# Browsers will show a "Not Secure" / cert warning on first visit — accept
# it once per device and downloads will work (HTTPS is enough to unblock
# Chrome's "Insecure download blocked" gate for MP4s from a data: URL / same
# origin).
#
# Preferred long-term fix: enable HTTPS certs in your Tailscale admin
# (Tailnet DNS → HTTPS Certificates → Enable), then run:
#   tailscale cert --cert-file swordbot.tail2a1eb4.ts.net.crt \
#                  --key-file  swordbot.tail2a1eb4.ts.net.key \
#                  swordbot.tail2a1eb4.ts.net
# and point TLS_CERT_FILE / TLS_KEY_FILE at those files. The server code
# accepts either cert source.

set -euo pipefail

cd "$(dirname "$0")"

CN="swordbot.tail2a1eb4.ts.net"
CRT="${CN}.crt"
KEY="${CN}.key"
CFG="openssl.cnf"

cat > "$CFG" <<'EOF'
[req]
default_bits       = 2048
prompt             = no
default_md         = sha256
req_extensions     = req_ext
distinguished_name = dn

[dn]
CN = swordbot.tail2a1eb4.ts.net

[req_ext]
subjectAltName = @alt_names

[alt_names]
DNS.1 = swordbot.tail2a1eb4.ts.net
DNS.2 = swordbot
DNS.3 = swordbot.local
DNS.4 = localhost
IP.1  = 127.0.0.1
IP.2  = 100.87.47.112
IP.3  = ::1
EOF

openssl req -x509 -newkey rsa:2048 -nodes \
  -days 825 \
  -keyout "$KEY" \
  -out "$CRT" \
  -config "$CFG" \
  -extensions req_ext

chmod 600 "$KEY"
chmod 644 "$CRT"

echo
echo "Wrote $CRT + $KEY (self-signed, valid 825 days)."
echo "Point TLS_CERT_FILE and TLS_KEY_FILE at those files in the LaunchAgent plist."
