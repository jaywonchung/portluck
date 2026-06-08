#!/usr/bin/env bash
# Unregister the Portluck native host from a Chromium-family browser.
# With no argument, removes it from every known browser.
set -euo pipefail

HOST_NAME="com.portluck.host"
ALL="chrome canary chromium brave edge"

dir_for() {
  case "$1" in
    chrome)   echo "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" ;;
    canary)   echo "$HOME/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts" ;;
    chromium) echo "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" ;;
    brave)    echo "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" ;;
    edge)     echo "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts" ;;
    *) return 1 ;;
  esac
}

usage() {
  echo "Usage: $0 [chrome|canary|chromium|brave|edge]"
  echo "  With no argument, removes the host manifest from every known browser."
  exit 1
}

case "${1:-}" in
  -h|--help) usage ;;
esac

if [ $# -ge 1 ]; then
  dir_for "$1" >/dev/null || { echo "error: unknown browser '$1'"; usage; }
  TARGETS="$1"
else
  TARGETS="$ALL"
fi

removed=0
for b in $TARGETS; do
  MANIFEST="$(dir_for "$b")/$HOST_NAME.json"
  if [ -f "$MANIFEST" ]; then
    rm -f "$MANIFEST"
    echo "Removed $MANIFEST"
    removed=$((removed + 1))
  fi
done

if [ "$removed" -gt 0 ]; then
  echo "Removed $removed manifest(s)."
else
  echo "No Portluck host manifest found."
fi
echo "The extension stays loaded; remove it at chrome://extensions if you want it gone."
