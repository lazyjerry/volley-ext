#!/usr/bin/env bash
# 打包 vsix 並安裝到本機 VSCode。
set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
VSIX="${NAME}-${VERSION}.vsix"

npm run package:vsix

if [[ ! -f "$VSIX" ]]; then
  echo "找不到 $VSIX" >&2
  exit 1
fi

if ! command -v code >/dev/null 2>&1; then
  echo "找不到 code CLI，請在 VSCode 執行「Shell Command: Install 'code' command in PATH」" >&2
  exit 1
fi

code --install-extension "$VSIX" --force
# ${} 必要：變數展開緊接全形字元時，bash 會把多位元組字元誤併入變數名
echo "已安裝 ${VSIX}（重新載入 VSCode 視窗後生效）"
