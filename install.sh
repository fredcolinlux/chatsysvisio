#!/usr/bin/env bash
# ChatSysVisio — INSTALLATION NEUVE sur un CT Debian 13 (trixie) non privilégié, derrière Nginx Proxy Manager.
# Usage (root, depuis le dossier extrait de chatsysvisio-complet.tar.gz) :
#   bash install.sh
#   NONINTERACTIVE=1 PUBLIC_URL=https://chat.exemple.fr NPM_IP=10.0.0.10 bash install.sh
#   DRY_RUN=1 bash install.sh        (test à blanc : affiche ce qui serait fait, ne modifie rien)
# Si une installation existe déjà (/opt/chatsysvisio), utilisez update.sh (ce script le propose).
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "ChatSysVisio $(cat "$SRC/VERSION" 2>/dev/null || echo ?) (build $(cat "$SRC/BUILD" 2>/dev/null || echo ?)) — sources : $SRC"
. "$SRC/deploy/lib-install.sh"
[ "${DRY_RUN:-0}" = 1 ] && warn "TEST À BLANC : aucune modification du système." || require_root
check_os

if [ -f "$APP_DIR/server/index.mjs" ] || [ -f "$SYSTEMD_DIR/chatsysvisio.service" ]; then
  warn "Une installation existe déjà ($APP_DIR)."
  if [ "${NONINTERACTIVE:-0}" = 1 ]; then exec bash "$SRC/update.sh"; fi
  read -r -p "Lancer la MISE À JOUR (sauvegarde + conservation de la config et des données) ? [O/n] " a </dev/tty || true
  case "${a:-O}" in [nN]*) die "abandon.";; esac
  exec bash "$SRC/update.sh"
fi

install_packages
ensure_user
write_env
PUBLIC_URL=${PUBLIC_URL%/}
case "$PUBLIC_URL" in https://*) ;; *) warn "PUBLIC_URL devrait commencer par https:// (caméra et micro exigent HTTPS)";; esac
deploy_code "$SRC"
install_units "$SRC"
start_service || true
admin_setup
record_update "installation"
[ "${DRY_RUN:-0}" = 1 ] || bash "$SRC/deploy/security-scan.sh" "$ENV_FILE" || true   # en-têtes locaux + scan WebGuardian (non bloquant)
[ "${DRY_RUN:-0}" = 1 ] || summary
