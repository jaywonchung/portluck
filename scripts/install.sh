#!/usr/bin/env bash
# Build the Portluck native host and register it with a Chromium-family browser.
#
# Usage: ./install.sh [chrome|canary|chromium|brave|edge]
#   The extension ID is pinned by the "key" field in extension/manifest.json, so
#   you normally pass nothing. Override it (e.g. if you loaded the extension
#   without the key) with: PORTLUCK_EXT_ID=... ./install.sh
set -euo pipefail

HOST_NAME="com.portluck.host"
# Stable extension ID derived from the "key" in extension/manifest.json.
PINNED_ID="ieefaffakndbkfepmnpkolganahdnafg"

usage() {
  echo "Usage: $0 [chrome|canary|chromium|brave|edge]"
  echo "  Extension ID defaults to the pinned id ($PINNED_ID)."
  echo "  Override with: PORTLUCK_EXT_ID=... $0 [browser]"
  exit 1
}

EXT_ID="${PORTLUCK_EXT_ID:-$PINNED_ID}"
BROWSER="${1:-chrome}"

HERE="$(cd "$(dirname "$0")" && pwd)"
NATIVE_HOST="$(cd "$HERE/../native-host" && pwd)"
BIN="$NATIVE_HOST/target/release/portluck-host"

echo "Building native host (cargo build --release)..."
( cd "$NATIVE_HOST" && cargo build --release )
[ -x "$BIN" ] || { echo "error: build did not produce $BIN"; exit 1; }

case "$BROWSER" in
  chrome)   DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
  canary)   DIR="$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts" ;;
  chromium) DIR="$HOME/Library/Application Support/Chromium/NativeMessagingHosts" ;;
  brave)    DIR="$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
  edge)     DIR="$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" ;;
  -h|--help) usage ;;
  *) echo "error: unknown browser '$BROWSER'"; usage ;;
esac

mkdir -p "$DIR"
MANIFEST="$DIR/$HOST_NAME.json"

cat > "$MANIFEST" <<EOF
{
  "name": "$HOST_NAME",
  "description": "Portluck SSH port-forward native host",
  "path": "$BIN",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXT_ID/"
  ]
}
EOF

echo "Wrote $MANIFEST"
echo "Binary:  $BIN"
echo "Allowed: chrome-extension://$EXT_ID/"
echo "Done. Reload the extension (or restart the browser) so it can connect to the host."
