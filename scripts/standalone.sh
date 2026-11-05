#!/usr/bin/env bash
# Paquet AUTONOME hors ligne : chatsysvisio-<version>.tar.gz (aucun téléchargement à l'installation, pas de Docker).
# Contient : code, node_modules de production (ws), public/vendor (MediaPipe, QR), modèle, police Inter
# et le Node.js officiel linux-x64 + linux-arm64 (runtime/, vérifié par SHA256 à la construction ET à l'installation).
# Usage : bash scripts/standalone.sh [dossier_sortie]   ·   NODE_VERSION=v24.22.2   ·   NODE_CACHE=dossier des .tar.xz
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; OUT=$(cd "${1:-$ROOT/..}" && pwd)
NV=${NODE_VERSION:-v24.22.2}; CACHE=${NODE_CACHE:-$ROOT/../.node-cache}
cd "$ROOT"
[ -f public/vendor/mediapipe/vision_bundle.mjs ] || node scripts/vendor.mjs
[ -f node_modules/ws/package.json ] || npm ci --omit=dev
V=$(cat VERSION); NAME=chatsysvisio-$V
mkdir -p "$CACHE"
[ -f "$CACHE/SHASUMS256.txt" ] || curl -fsS -o "$CACHE/SHASUMS256.txt" "https://nodejs.org/dist/$NV/SHASUMS256.txt"
for a in x64 arm64; do f=node-$NV-linux-$a.tar.xz; [ -f "$CACHE/$f" ] || curl -fsS -o "$CACHE/$f" "https://nodejs.org/dist/$NV/$f"; done
( cd "$CACHE" && grep -E " node-$NV-linux-(x64|arm64)\.tar\.xz\$" SHASUMS256.txt | sha256sum -c --quiet ) || { echo "SHA256 Node invalide" >&2; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT; dir=$tmp/$NAME; mkdir -p "$dir/runtime" "$dir/node_modules"
git ls-files -z | tar --null -T - -cf - | tar -C "$dir" -xf -
rm -rf "$dir/test" "$dir/playwright.config.mjs" "$dir/docs/img" "$dir/scripts/screenshots.mjs" "$dir/scripts/design-shots.mjs" "$dir/scripts/color-measure.mjs"
cp -a node_modules/ws "$dir/node_modules/"; cp -a public/vendor "$dir/public/"
cp "$CACHE"/node-$NV-linux-{x64,arm64}.tar.xz "$CACHE/SHASUMS256.txt" "$dir/runtime/"
( cd "$dir" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS )
tar -C "$tmp" --owner=0 --group=0 --sort=name -czf "$OUT/$NAME.tar.gz" "$NAME"
( cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256" )
echo "$OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1)) — Node $NV x64+arm64 embarqué — $(cut -d' ' -f1 "$OUT/$NAME.tar.gz.sha256")"
