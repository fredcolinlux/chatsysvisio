#!/usr/bin/env bash
# Retour arrière de deploy/migrate-from.sh : remet l'installation sous l'ancien nom telle qu'avant la migration
# (code, configuration, unités systemd, CLI), avec par défaut les DONNÉES ACTUELLES (même format : rien n'est perdu
# de ce qui a été fait depuis la migration). ROLLBACK_DATA=origine : reprendre les données d'avant la migration.
#   OLD_NAME=ancien-nom bash deploy/rollback-migration.sh        (root)
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OLD=${OLD_NAME:?OLD_NAME requis}; . "$SRC/deploy/lib-install.sh"; require_root
MIG_BK=${MIG_BK:-/var/backups/chatsysvisio-migration}; REF=$MIG_BK/reference-avant-migration.tar.gz
[ -f "$REF" ] || die "référence $REF introuvable : rien à annuler."
tar -tzf "$REF" >/dev/null || die "référence illisible"
STAMP=$(date +%Y%m%d-%H%M%S)
O_DATA=$(tar -xzOf "$REF" "etc/$OLD/$OLD.env" 2>/dev/null | sed -n "s/^[[:space:]]*DATA_DIR=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}$/\1/p" | tail -n1); O_DATA=${O_DATA:-/var/lib/$OLD}
log "Arrêt de ChatSysVisio"
for u in chatsysvisio.service chatsysvisio-backup.timer chatsysvisio-backup.path chatsysvisio-status.timer chatsysvisio-status.path; do systemctl disable --now "$u" >/dev/null 2>&1 || true; done
# sauvegarde de l'état migré avant de le défaire
( umask 077; items=(); for p in "$APP_DIR" "$ETC_DIR" "$DATA_DIR"; do [ -e "$p" ] && items+=("${p#/}"); done
  [ ${#items[@]} = 0 ] || tar -C / -czf "$MIG_BK/etat-migre-avant-rollback-$STAMP.tar.gz" "${items[@]}" )
echo "  état migré sauvegardé : $MIG_BK/etat-migre-avant-rollback-$STAMP.tar.gz"
log "Restauration de la référence $REF"
excl=(--exclude="${APP_DIR#/}" --exclude="${ETC_DIR#/}" --exclude="${DATA_DIR#/}" --exclude="${SYSTEMD_DIR#/}/chatsysvisio*" --exclude="usr/local/sbin/chatsysvisio-*"); keepdata=0; if [ "${ROLLBACK_DATA:-actuelles}" != origine ] && [ -d "$DATA_DIR" ]; then excl+=(--exclude="${O_DATA#/}"); keepdata=1; fi
rm -f /usr/local/sbin/$OLD-admin
tar -C / "${excl[@]}" -xzf "$REF"
if [ $keepdata = 1 ]; then
  echo "  données : copie des données actuelles $DATA_DIR -> $O_DATA (l'ancien contenu gardé dans $O_DATA.avant-rollback-$STAMP)"
  [ -d "$O_DATA" ] && mv "$O_DATA" "$O_DATA.avant-rollback-$STAMP"
  cp -a "$DATA_DIR" "$O_DATA"; rm -f "$O_DATA"/.migre-depuis-*
else echo "  données : celles d'avant la migration ($O_DATA)"; fi
id "$OLD" >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$OLD"
chown -R "$OLD:$OLD" "$O_DATA"
log "Retrait de ChatSysVisio (mis de côté en *.annule-$STAMP)"
rm -f "$SYSTEMD_DIR"/chatsysvisio* /usr/local/sbin/chatsysvisio-* /etc/apt/apt.conf.d/99chatsysvisio
for d in "$APP_DIR" "$ETC_DIR" "$DATA_DIR"; do [ -e "$d" ] && mv "$d" "$d.annule-$STAMP"; done
rm -rf "$APP_DIR.prev"
mv "$REF" "$MIG_BK/reference-utilisee-$STAMP.tar.gz"   # une nouvelle migration refera sa propre référence
systemctl daemon-reload || true
log "Redémarrage de $OLD"
while read -r u en ac; do case "$en" in enabled) systemctl enable "$u" >/dev/null 2>&1 || true;; esac; case "$ac" in active) systemctl start "$u" >/dev/null 2>&1 || true;; esac
done < "$MIG_BK/reference-etat-unites.txt"
systemctl enable --now "$OLD.service" >/dev/null 2>&1 || true
port=$(sed -n "s/^PORT=['\"]\{0,1\}\([0-9]*\).*/\1/p" "/etc/$OLD/$OLD.env" | tail -n1); port=${port:-8790}
for i in $(seq 1 30); do h=$(curl -fsS -m 2 "http://127.0.0.1:$port/healthz" 2>/dev/null) && break; sleep 1; done
echo "  /healthz : ${h:-AUCUNE RÉPONSE (journalctl -u $OLD -n 50)}"
echo "Retour arrière terminé : $OLD de nouveau en service. Utilisateurs : Ctrl+F5 ; administrateurs : reconnexion."
[ -n "${h:-}" ]
