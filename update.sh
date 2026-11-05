#!/usr/bin/env bash
# ChatSysVisio — MISE À JOUR d'une installation existante.
#  1. sauvegarde (code, configuration, données) dans /var/backups/chatsysvisio
#  2. remplacement du code (l'ancien est gardé dans /opt/chatsysvisio.prev ; restauré automatiquement en cas d'échec)
#  3. migration de la configuration (valeurs existantes conservées), services, redémarrage
#  4. contrôle de sécurité : en-têtes locaux + scan public WebGuardian (non bloquant)
# Usage (root) :  bash update.sh      ·   DRY_RUN=1 bash update.sh (à blanc)   ·   SECURITY_SCAN=0 pour sauter le scan public
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "ChatSysVisio $(cat "$SRC/VERSION" 2>/dev/null || echo ?) (build $(cat "$SRC/BUILD" 2>/dev/null || echo ?)) — sources : $SRC"
. "$SRC/deploy/lib-install.sh"
[ "${DRY_RUN:-0}" = 1 ] && warn "TEST À BLANC : aucune modification du système." || require_root
check_os
[ -f "$SRC/server/index.mjs" ] || die "sources introuvables dans $SRC"
if [ "${DRY_RUN:-0}" != 1 ]; then
  [ -d "$APP_DIR" ] || die "aucune installation dans $APP_DIR (utilisez install.sh)."
  [ -f "$ENV_FILE" ] || die "$ENV_FILE absent : installation incomplète ?"
fi
OLD_VER="$(cat "$APP_DIR/VERSION" 2>/dev/null || echo ?) (build $(cat "$APP_DIR/BUILD" 2>/dev/null || echo ?))"
echo "Version installée : $(cat "$APP_DIR/VERSION" 2>/dev/null || echo ?) (build $(cat "$APP_DIR/BUILD" 2>/dev/null || echo ?))  →  nouvelle : $(cat "$SRC/VERSION" 2>/dev/null || echo ?) (build $(cat "$SRC/BUILD" 2>/dev/null || echo ?))"

STAMP=$(date +%Y%m%d-%H%M%S); BK="$BACKUP_DIR/chatsysvisio-maj-$STAMP.tar.gz"
log "Sauvegarde -> $BK"
if [ "${DRY_RUN:-0}" = 1 ]; then echo "  [à blanc] tar de $APP_DIR $ETC_DIR $DATA_DIR"; else
  install -d -m 0700 -o root -g root "$BACKUP_DIR"
  items=(); for p in "$APP_DIR" "$ETC_DIR" "$DATA_DIR" "$SYSTEMD_DIR/chatsysvisio.service"; do [ -e "$p" ] && items+=("${p#/}"); done
  ( umask 077; tar -C / --exclude="${APP_DIR#/}/node_modules" --exclude="${APP_DIR#/}/public/vendor" -czf "$BK" "${items[@]}" )
  tar -tzf "$BK" >/dev/null || die "archive de sauvegarde illisible, abandon (rien n'a été modifié)."
  echo "  $(du -h "$BK" | cut -f1) — restauration : tar -C / -xzf $BK"
  ls -1t "$BACKUP_DIR"/chatsysvisio-maj-*.tar.gz 2>/dev/null | tail -n +6 | xargs -r rm -f   # garde les 5 dernières
fi

install_packages
ensure_user

log "Arrêt du service"
run systemctl stop chatsysvisio.service 2>/dev/null || true
log "Remplacement du code (ancien conservé dans $APP_DIR.prev)"
if [ "${DRY_RUN:-0}" = 1 ]; then deploy_code "$SRC"; else
  rm -rf "$APP_DIR.prev"; mv "$APP_DIR" "$APP_DIR.prev"
  if ! ( deploy_code "$SRC" ); then
    warn "échec : restauration de l'ancien code"; rm -rf "$APP_DIR"; mv "$APP_DIR.prev" "$APP_DIR"
    systemctl start chatsysvisio.service || true; exit 1
  fi
fi
migrate_env
install_units "$SRC"
if ! start_service; then
  if [ "${DRY_RUN:-0}" != 1 ] && [ -d "$APP_DIR.prev" ]; then
    warn "la nouvelle version ne démarre pas : retour à l'ancienne"
    rm -rf "$APP_DIR.failed"; mv "$APP_DIR" "$APP_DIR.failed"; mv "$APP_DIR.prev" "$APP_DIR"
    systemctl restart chatsysvisio.service || true
    if start_service; then warn "ancienne version rétablie et opérationnelle"; else warn "l'ancienne version ne répond pas non plus"; fi
    die "mise à jour annulée (code défaillant gardé dans $APP_DIR.failed ; journalctl -u chatsysvisio -n 80)"
  fi
fi
record_update "$OLD_VER"
admin_setup
[ "${DRY_RUN:-0}" = 1 ] || bash "$SRC/deploy/security-scan.sh" "$ENV_FILE" || true
[ "${DRY_RUN:-0}" = 1 ] || { summary; echo "Sauvegarde : $BK   ·   ancien code : $APP_DIR.prev"; }
