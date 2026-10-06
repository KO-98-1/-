#!/usr/bin/env sh
# SW 표준 산출물 자동 작성 앱 실행 (macOS·Linux)
cd "$(dirname "$0")" || exit 1
[ -d node_modules ] || npm install --no-audit --no-fund || exit 1
exec node server.mjs --open
