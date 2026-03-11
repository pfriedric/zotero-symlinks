#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"
TMP="$DIST/package-tmp"
VERSION="$(python3 - <<'PY'
import json, pathlib
manifest = json.loads(pathlib.Path('manifest.json').read_text())
print(manifest['version'])
PY
)"
NAME="zotero-linked-collections-v${VERSION}.xpi"

rm -rf "$TMP"
mkdir -p "$TMP" "$DIST"

cp "$ROOT/bootstrap.js" "$TMP/"
cp "$ROOT/linked-collections.js" "$TMP/"
cp "$ROOT/manifest.json" "$TMP/"
mkdir -p "$TMP/locale/en-US"
cp "$ROOT/locale/en-US/linked-collections.ftl" "$TMP/locale/en-US/"

(
  cd "$TMP"
  zip -qr "$DIST/$NAME" .
)

rm -rf "$TMP"
echo "Created $DIST/$NAME"
