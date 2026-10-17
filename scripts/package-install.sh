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

# --install-extension 只裝進目前（預設）profile；開著其他 profile 的視窗仍會載到舊版，
# 所以把使用者建立的每個 profile 都裝一遍。profile 清單在 VSCode 的 globalStorage/storage.json。
code --install-extension "$VSIX" --force
STORAGE="$HOME/Library/Application Support/Code/User/globalStorage/storage.json"
if [[ -f "$STORAGE" ]]; then
  node -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const p of d.userDataProfiles ?? []) {
      if (!String(p.location).startsWith("builtin/")) console.log(p.name);
    }
  ' "$STORAGE" | while IFS= read -r profile; do
    code --profile "$profile" --install-extension "$VSIX" --force
  done
fi
# ${} 必要：變數展開緊接全形字元時，bash 會把多位元組字元誤併入變數名
echo "已安裝 ${VSIX} 到預設與所有自訂 profile（重新載入 VSCode 視窗後生效）"
