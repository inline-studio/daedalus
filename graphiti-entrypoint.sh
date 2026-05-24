#!/bin/sh
# daedalus graphiti entrypoint.
#
# graphiti reaches your spark endpoint THROUGH the OneCLI proxy (so the spark key is
# never stored in graphiti's env/disk — OneCLI injects it). OneCLI is an HTTPS-MITM
# proxy, so graphiti's Python client must trust OneCLI's CA. httpx (which the openai
# SDK uses) ignores SSL_CERT_FILE/REQUESTS_CA_BUNDLE and trusts ONLY certifi's bundle,
# so we append the mounted CA to the venv's certifi bundle (and the system store, for
# curl/openssl) at startup. Best-effort + idempotent: if no CA is mounted we just start
# normally (e.g. a deployment that doesn't route graphiti through OneCLI).
CA=/certs/onecli-ca.pem
SENT=/var/run/.dae-ca-appended
if [ -f "$CA" ] && [ ! -f "$SENT" ]; then
  CB="$(/app/mcp/.venv/bin/python -c 'import certifi; print(certifi.where())' 2>/dev/null || true)"
  if [ -n "$CB" ] && [ -f "$CB" ]; then
    { printf '\n'; cat "$CA"; printf '\n'; } >> "$CB" 2>/dev/null \
      && echo "graphiti-entrypoint: trusted OneCLI CA via certifi ($CB)"
  fi
  for f in /etc/ssl/certs/ca-certificates.crt /etc/ssl/cert.pem; do
    if [ -f "$f" ]; then
      { printf '\n'; cat "$CA"; printf '\n'; } >> "$f" 2>/dev/null
    fi
  done
  touch "$SENT" 2>/dev/null || true
fi

exec /start-services.sh
