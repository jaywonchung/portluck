#!/usr/bin/env bash

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

( cd "$ROOT/native-host" && cargo fmt --check )

( cd "$ROOT/native-host" && cargo clippy --all-targets -- -D warnings )

for f in "$ROOT"/extension/*.js; do node --check "$f"; done
