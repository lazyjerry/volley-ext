#!/usr/bin/env bash
# 更新 Marketplace 版本與 GitHub metadata，驗證後產生對應 VSIX。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_VERSION="${1:-}"

if [[ ! "$TARGET_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "用法: $0 <major.minor.patch>" >&2
  exit 1
fi

cd "$ROOT"

CURRENT_VERSION="$(node -p "require('./package.json').version")"
node - "$CURRENT_VERSION" "$TARGET_VERSION" <<'NODE'
const [, , current, target] = process.argv;
const parse = (version) => version.split('.').map(Number);
const [currentMajor, currentMinor, currentPatch] = parse(current);
const [targetMajor, targetMinor, targetPatch] = parse(target);
if (target === current) {
  process.exit(0);
}
const isGreater = targetMajor > currentMajor
  || (targetMajor === currentMajor && targetMinor > currentMinor)
  || (targetMajor === currentMajor && targetMinor === currentMinor && targetPatch > currentPatch);

if (!isGreater) {
  console.error(`目標版本 ${target} 必須高於目前版本 ${current}`);
  process.exit(1);
}
NODE

if [[ "$CURRENT_VERSION" != "$TARGET_VERSION" ]]; then
  npm version "$TARGET_VERSION" --no-git-tag-version
fi
npm pkg set \
  'repository.type=git' \
  'repository.url=https://github.com/lazyjerry/volley-ext.git' \
  'homepage=https://github.com/lazyjerry/volley-ext#readme' \
  'bugs.url=https://github.com/lazyjerry/volley-ext/issues' \
  'scripts.package:vsix=npm run check && vsce package --no-dependencies'

node - "$TARGET_VERSION" <<'NODE'
const [, , expectedVersion] = process.argv;
const manifest = require('./package.json');
const lockfile = require('./package-lock.json');

const expectedRepository = 'https://github.com/lazyjerry/volley-ext.git';
if (manifest.version !== expectedVersion
  || lockfile.version !== expectedVersion
  || lockfile.packages?.['']?.version !== expectedVersion
  || manifest.repository?.url !== expectedRepository) {
  console.error('package.json 與 package-lock.json 版本或 repository 設定不一致');
  process.exit(1);
}
NODE

./scripts/dropbox-ignore.sh
npm run package:vsix

VSIX="volley-${TARGET_VERSION}.vsix"
test -f "$VSIX"

unzip -p "$VSIX" extension/package.json | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const expectedVersion = process.argv[1];
  const manifest = JSON.parse(input);
  if (manifest.version !== expectedVersion
    || manifest.repository?.url !== "https://github.com/lazyjerry/volley-ext.git") {
    console.error("VSIX manifest 的版本或 repository 不正確");
    process.exit(1);
  }
});
' "$TARGET_VERSION"

shasum -a 256 "$VSIX"
