#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
(cd native-host && cargo test --locked && cargo build --locked)
node --test tests/*.test.cjs
