#!/usr/bin/env bash
# Construit les deux archives de livraison (aucune publication), numérotées version + build :
#   chatsysvisio-complet-<version>-b<build>.tar.gz      installation neuve : bash install.sh
#   chatsysvisio-mise-a-jour-<version>-b<build>.tar.gz  mise à jour d'une installation existante : bash update.sh
# + une copie sans numéro (chatsysvisio-complet.tar.gz, chatsysvisio-mise-a-jour.tar.gz) pour les commandes de la doc.
# Le numéro de build (fichier BUILD, à commiter) est incrémenté à chaque empaquetage et inscrit dans l'archive.
# BUILD_KEEP=1 : ne pas incrémenter (reconstruire le même build).
# Les deux contiennent le code, public/vendor (MediaPipe, QR, RNNoise, DeepFilterNet3) et node_modules/ws : aucune dépendance téléchargée à l'installation.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; OUT=$(cd "${1:-$ROOT/..}" && pwd)
cd "$ROOT"
[ -f public/vendor/mediapipe/vision_bundle.mjs ] && [ -f public/vendor/rnnoise/rnnoise-worklet.js ] && [ -f public/vendor/deepfilter/df_bg.wasm.br ] || node scripts/vendor.mjs
[ -f node_modules/ws/package.json ] || npm ci --omit=dev
V=$(cat VERSION)
B=$(cat BUILD 2>/dev/null || echo 0); [[ "$B" =~ ^[0-9]+$ ]] || { echo "BUILD invalide : $B" >&2; exit 1; }
[ "${BUILD_KEEP:-0}" = 1 ] || { B=$((B + 1)); echo "$B" > BUILD; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
build() { # nom dossier [exclusions...]
  local name=$1 top=$2 dir=$tmp/$2; shift 2
  local file="$name-$V-b$B.tar.gz"
  mkdir -p "$dir"
  git ls-files -z | tar --null -T - -cf - | tar -C "$dir" -xf -
  # fichiers de travail non encore commités (ex. version en cours) : on prend l'arbre courant
  git ls-files -z -m | tar --null -T - -cf - 2>/dev/null | tar -C "$dir" -xf - 2>/dev/null || true
  echo "$B" > "$dir/BUILD"; echo "$V" > "$dir/VERSION"
  mkdir -p "$dir/node_modules" && cp -a node_modules/ws "$dir/node_modules/"
  cp -a public/vendor "$dir/public/"
  for x in "$@"; do rm -rf "${dir:?}/$x"; done
  tar -C "$tmp" --owner=0 --group=0 -czf "$OUT/$file" "$top"
  cp -f "$OUT/$file" "$OUT/$name.tar.gz"
  echo "$OUT/$file ($(du -h "$OUT/$file" | cut -f1), version $V, build $B) + copie $OUT/$name.tar.gz"
}
build chatsysvisio-complet chatsysvisio
build chatsysvisio-mise-a-jour chatsysvisio-maj test scripts/screenshots.mjs playwright.config.mjs
echo "Build $B : pensez à commiter le fichier BUILD (git commit BUILD -m \"Build $B\")."
