#!/usr/bin/env bash
# 將建構產物目錄標記為 Dropbox 忽略，避免同步大量暫存檔，
# 並繞開 macOS App Management 對 .vscode-test 內簽署 app bundle 的保護。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGETS=(node_modules out .vscode-test)

usage() {
  echo "用法: $0 [--revert] [--status]"
  echo "  (無參數)   標記為 Dropbox 忽略"
  echo "  --revert   取消忽略標記"
  echo "  --status   只顯示目前狀態"
}

MODE="apply"
case "${1:-}" in
  --revert) MODE="revert" ;;
  --status) MODE="status" ;;
  -h|--help) usage; exit 0 ;;
  "") ;;
  *) usage; exit 1 ;;
esac

for t in "${TARGETS[@]}"; do
  path="$ROOT/$t"
  if [[ ! -e "$path" ]]; then
    printf '%-16s 不存在，略過\n' "$t"
    continue
  fi

  case "$MODE" in
    apply)  xattr -w com.dropbox.ignored 1 "$path" ;;
    revert) xattr -d com.dropbox.ignored "$path" 2>/dev/null || true ;;
  esac

  if xattr -p com.dropbox.ignored "$path" >/dev/null 2>&1; then
    printf '%-16s 已忽略\n' "$t"
  else
    printf '%-16s 同步中\n' "$t"
  fi
done
