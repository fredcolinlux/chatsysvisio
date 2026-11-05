#!/usr/bin/env bash
# Sauvegarde de /var/lib/chatsysvisio (salons, historique, fichiers partagés) + /etc/chatsysvisio -> /var/backups/chatsysvisio.
# Comprend les comptes (accounts.json), l'administrateur (admin.json), les réglages et le journal.
# Restauration : systemctl stop chatsysvisio && tar -C / -xzf <archive> && systemctl start chatsysvisio
set -euo pipefail
DATA=${DATA_DIR:-/var/lib/chatsysvisio}; ETC=${ETC_DIR:-/etc/chatsysvisio}
DEST=${BACKUP_DIR:-/var/backups/chatsysvisio}; KEEP=${KEEP_DAYS:-14}
# Demande venue de la page d'administration (fichier surveillé par chatsysvisio-backup.path) : consommée d'abord.
rm -f "$DATA/requests/backup"
install -d -m 0700 -o root -g root "$DEST"
f="$DEST/chatsysvisio-donnees-$(date +%Y%m%d-%H%M%S).tar.gz"
items=(); for p in "$DATA" "$ETC"; do [ -e "$p" ] && items+=("${p#/}"); done
( umask 077; tar -C / -czf "$f" "${items[@]}" )
tar -tzf "$f" >/dev/null
find "$DEST" -maxdepth 1 -name 'chatsysvisio-donnees-*.tar.gz' -mtime +"$KEEP" -delete
echo "sauvegarde : $f ($(du -h "$f" | cut -f1))"
# met à jour la liste affichée dans l'administration
[ -x /usr/local/sbin/chatsysvisio-status ] && /usr/local/sbin/chatsysvisio-status >/dev/null 2>&1 || true
