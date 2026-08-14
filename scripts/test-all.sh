#!/usr/bin/env bash
# 全功能回歸測試：lint → typecheck → build → 單元測試 → 整合測試。
# 日後更新程式碼只需跑這一支確認未破壞既有功能。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

echo "==> lint"
npm run lint

echo "==> typecheck + build"
npm run build

echo "==> unit tests"
npm run test:unit

echo "==> integration tests (VSCode Extension Host)"
npm run test:integration

echo "✅ 全部通過"
