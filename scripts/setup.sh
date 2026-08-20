#!/usr/bin/env bash
# One-time setup: mkcert root CA + TLS cert for the studio's LAN hostname.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v mkcert >/dev/null; then
  echo "Installing mkcert via Homebrew..."
  brew install mkcert
fi

echo "Installing the mkcert root CA into the macOS trust store (may prompt for your password)..."
mkcert -install

HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s)"
IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo 127.0.0.1)"

mkdir -p server/certs
mkcert \
  -cert-file server/certs/cert.pem \
  -key-file server/certs/key.pem \
  "${HOST}.local" localhost 127.0.0.1 "${IP}"

cp "$(mkcert -CAROOT)/rootCA.pem" server/certs/rootCA.pem

echo
echo "Certs ready in server/certs/."
echo "Studio URL will be: https://${HOST}.local:4433"
echo "On each iPhone/iPad (once): open http://${HOST}.local:4434/ and follow the 4 steps."
