#!/usr/bin/env bash
# Migration d'une installation existante sous un ANCIEN NOM (ex. OLD_NAME=ancien-nom : /opt/ancien-nom, service
# ancien-nom, /etc/ancien-nom/ancien-nom.env, /var/lib/ancien-nom) vers ChatSysVisio, même version de données.
#   OLD_NAME=ancien-nom bash deploy/migrate-from.sh        (root, depuis le dossier extrait)
#   DRY_RUN=1 …  : à blanc   ·   relançable sans dommage (idempotent)   ·   retour arrière : deploy/rollback-migration.sh
# Conserve la configuration À L'IDENTIQUE (domaine, proxy de confiance, ALLOW_FROM, ADMIN_ALLOW_CIDR, port, clés…), les
# données (salons, historique, fichiers, comptes, administrateurs + TOTP + codes de secours) et l'étiquette E2EE d'origine.
# Ne touche ni au réseau, ni au proxy, ni au pare-feu. Ne télécharge rien.
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OLD=${OLD_NAME:?OLD_NAME requis (nom court de l\'ancienne installation)}
[[ "$OLD" =~ ^[a-z][a-z0-9-]{1,30}$ ]] && [ "$OLD" != chatsysvisio ] || { echo "OLD_NAME invalide : $OLD" >&2; exit 1; }
. "$SRC/deploy/lib-install.sh"
O_APP=/opt/$OLD O_ETC=/etc/$OLD O_ENV=/etc/$OLD/$OLD.env O_BK=/var/backups/$OLD
MIG_BK=${MIG_BK:-/var/backups/chatsysvisio-migration}; REF=$MIG_BK/reference-avant-migration.tar.gz
MARK=$DATA_DIR/.migre-depuis-$OLD
O_UNITS="$OLD.service $OLD-backup.timer $OLD-backup.path $OLD-status.timer $OLD-status.path $OLD-backup.service $OLD-status.service"
N_UNITS="chatsysvisio.service chatsysvisio-backup.timer chatsysvisio-backup.path chatsysvisio-status.timer chatsysvisio-status.path"
STAMP=$(date +%Y%m%d-%H%M%S)
echo "Migration $OLD -> ChatSysVisio $(cat "$SRC/VERSION") (build $(cat "$SRC/BUILD")) — sources : $SRC"
[ "${DRY_RUN:-0}" = 1 ] && warn "TEST À BLANC : aucune modification." || require_root

# ---------- 0. État et prérequis (rien n'est modifié tant qu'ils ne sont pas réunis) ----------
NODE_BIN=$(command -v node || true); [ -n "$NODE_BIN" ] && [ "$(node_major)" -ge 20 ] || die "Node.js >= 20 introuvable (celui de l'installation actuelle est attendu)."
[ "$NODE_BIN" = /usr/local/bin/node ] && [ -x /usr/bin/node ] && NODE_BIN=/usr/bin/node
if [ -f "$MARK" ] && [ -f "$ENV_FILE" ]; then MODE=deja; else MODE=complete; fi
[ "$MODE" = complete ] && { [ -f "$O_ENV" ] || die "$O_ENV introuvable : pas d'installation « $OLD » à migrer."; }
SRC_ENV=$O_ENV; [ "$MODE" = deja ] && SRC_ENV=$ENV_FILE
O_DATA=$(sed -n "s/^[[:space:]]*DATA_DIR=['\"]\{0,1\}\([^'\"]*\)['\"]\{0,1\}$/\1/p" "$O_ENV" 2>/dev/null | tail -n1); O_DATA=${O_DATA:-/var/lib/$OLD}
echo "  mode : $([ "$MODE" = deja ] && echo "déjà migrée — remise en conformité (code, unités, alias)" || echo "migration complète")"
echo "  ancienne installation : $O_APP · $O_ENV · données $O_DATA"
echo "  Node : $NODE_BIN ($("$NODE_BIN" -v))"
oenv() { sed -n "s/^[[:space:]]*$1=//p" "$SRC_ENV" 2>/dev/null | tail -n1 | sed "s/^'\(.*\)'$/\1/; s/^\"\(.*\)\"$/\1/"; }
O_TRUST=$(oenv TRUSTED_PROXIES); O_ALLOW=$(oenv ALLOW_FROM); O_PORT=$(oenv PORT); O_URL=$(oenv PUBLIC_URL); O_CIDR=$(oenv ADMIN_ALLOW_CIDR)

# ---------- 1. Sauvegarde complète AVANT tout ----------
log "Sauvegarde complète -> $MIG_BK"
items=(); for p in "$O_APP" "$O_ETC" "$O_DATA" /etc/systemd/system/$OLD* /usr/local/sbin/$OLD-* /etc/apt/apt.conf.d/99$OLD \
                   "$APP_DIR" "$ETC_DIR" "$DATA_DIR" /etc/systemd/system/chatsysvisio* /usr/local/sbin/chatsysvisio-* /etc/apt/apt.conf.d/99chatsysvisio; do
  [ -e "$p" ] && items+=("${p#/}"); done
BK=$MIG_BK/migration-$STAMP.tar.gz
if [ "${DRY_RUN:-0}" = 1 ]; then echo "  [à blanc] tar de ${items[*]}"; else
  install -d -m 0700 -o root -g root "$MIG_BK"
  { for u in $O_UNITS $N_UNITS; do e=$(systemctl is-enabled "$u" 2>/dev/null || true); a=$(systemctl is-active "$u" 2>/dev/null || true); printf '%s %s %s\n' "$u" "${e:-absent}" "${a:-inactive}"; done; } > "$MIG_BK/etat-unites-$STAMP.txt"
  ( umask 077; tar -C / -czf "$BK" "${items[@]}" )
  tar -tzf "$BK" >/dev/null || die "sauvegarde illisible : abandon (rien n'a été modifié)."
  # La référence de retour arrière = l'état d'avant la PREMIÈRE migration (jamais écrasée par une relance).
  if [ "$MODE" = complete ] && [ ! -f "$REF" ]; then ln -f "$BK" "$REF"; cp "$MIG_BK/etat-unites-$STAMP.txt" "$MIG_BK/reference-etat-unites.txt"; fi
  echo "  $(du -h "$BK" | cut -f1) — $BK$( [ -f "$REF" ] && echo " · référence de retour arrière : $REF")"
fi

# ---------- 2. Arrêt des anciennes unités ----------
if [ "$MODE" = complete ] || systemctl is-enabled -q "$OLD.service" 2>/dev/null || systemctl is-active -q "$OLD.service" 2>/dev/null; then
  log "Arrêt et désactivation des unités $OLD*"
  for u in $O_UNITS; do run systemctl disable --now "$u" >/dev/null 2>&1 || true; done
fi

# ---------- 3. Utilisateur, configuration (conservée à l'identique), données ----------
ensure_user
if [ "$MODE" = complete ]; then
  log "Configuration : $O_ENV -> $ENV_FILE (valeurs conservées)"
  if [ "${DRY_RUN:-0}" != 1 ]; then
    tmp=$(mktemp); cp "$O_ENV" "$tmp"
    # seuls les chemins de l'ancien nom changent ; commentaires renommés
    sed -i -e "s#$O_DATA#$DATA_DIR#g; s#/var/lib/$OLD#$DATA_DIR#g; s#/opt/$OLD#$APP_DIR#g; s#/etc/$OLD#$ETC_DIR#g; s#/var/backups/$OLD#$BACKUP_DIR#g" \
           -e "/^[[:space:]]*#/ s#$OLD-admin#chatsysvisio-admin#g; /^[[:space:]]*#/ s#$OLD#chatsysvisio#g" "$tmp"
    # valeurs implicites de l'ancien code rendues explicites (les défauts de ChatSysVisio peuvent différer)
    odef() { sed -n "s/.*env\.$1 \(??\|||\) '\([^']*\)'.*/\2/p" "$O_APP/server/config.mjs" 2>/dev/null | head -n1; }
    add() { grep -q "^[[:space:]]*$1=" "$tmp" || { [ -n "$2" ] && { printf "# %s (valeur implicite de l'ancienne installation, rendue explicite)\n%s='%s'\n" "$3" "$1" "$2" >> "$tmp"; echo "  + $1 explicité"; }; }; }
    add TRUSTED_PROXIES "$(odef TRUSTED_PROXIES)" "Proxys de confiance"
    add ADMIN_ALLOW_CIDR "$(odef ADMIN_ALLOW_CIDR)" "Réseaux autorisés pour l'administration"
    add PORT "$(odef PORT || true)" "Port local"
    lbl=$(sed -n "s/^const L = s => '\([a-z0-9._\/-]*\/\)' + s;.*/\1/p" "$O_APP/public/js/e2ee.js" 2>/dev/null | head -n1)
    add E2EE_LABEL "$lbl" "Étiquette E2EE d'origine : les salons chiffrés existants restent lisibles"
    install -m 0600 -o root -g root "$tmp" "$ENV_FILE"; rm -f "$tmp"
  fi
  log "Données : $O_DATA -> $DATA_DIR (copie ; l'original reste intact pour le retour arrière)"
  if [ "${DRY_RUN:-0}" != 1 ]; then
    [ -d "$O_DATA" ] || die "$O_DATA introuvable"
    rm -rf "$DATA_DIR.tmp"; cp -a "$O_DATA" "$DATA_DIR.tmp"
    rm -rf "$DATA_DIR"; mv "$DATA_DIR.tmp" "$DATA_DIR"
    chown -R "$APP_USER:$APP_USER" "$DATA_DIR"; chmod 0750 "$DATA_DIR"; install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR/requests"
    n_adm=$(grep -o '"user"' "$DATA_DIR/admin.json" 2>/dev/null | wc -l || true); n_acc=$(grep -o '"name"' "$DATA_DIR/accounts.json" 2>/dev/null | wc -l || true)
    echo "  administrateurs : $n_adm · comptes : $n_acc · $(du -sh "$DATA_DIR" | cut -f1)"
    cmp -s "$O_DATA/admin.json" "$DATA_DIR/admin.json" 2>/dev/null && echo "  admin.json identique (mot de passe, TOTP et codes de secours intacts)" || [ ! -f "$O_DATA/admin.json" ]
  fi
fi

# ---------- 4. Code, unités, CLI ----------
log "Arrêt de chatsysvisio (s'il tourne)"; run systemctl stop chatsysvisio.service 2>/dev/null || true
if [ "${DRY_RUN:-0}" = 1 ]; then deploy_code "$SRC"; else
  rm -rf "$APP_DIR.prev"; [ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.prev"
  ( deploy_code "$SRC" ) || { rm -rf "$APP_DIR"; [ -d "$APP_DIR.prev" ] && mv "$APP_DIR.prev" "$APP_DIR"; die "copie du code impossible"; }
fi
migrate_env
install_units "$SRC"
log "Ancienne CLI et fichiers système $OLD"
if [ "${DRY_RUN:-0}" != 1 ]; then
  rm -f /usr/local/sbin/$OLD-backup /usr/local/sbin/$OLD-status /usr/local/sbin/$OLD-node-check /etc/apt/apt.conf.d/99$OLD
  for u in $O_UNITS; do rm -f "$SYSTEMD_DIR/$u"; done
  cat > /usr/local/sbin/$OLD-admin <<ALIAS
#!/bin/sh
# Alias laissé par la migration vers ChatSysVisio.
echo "ATTENTION : $OLD-admin s'appelle désormais chatsysvisio-admin (redirection)." >&2
exec /usr/local/sbin/chatsysvisio-admin "\$@"
ALIAS
  chmod 0755 /usr/local/sbin/$OLD-admin
  systemctl daemon-reload || true
fi
echo "  unités $OLD* retirées (copie dans la sauvegarde) · alias $OLD-admin -> chatsysvisio-admin"

# ---------- 5. Démarrage et vérifications ----------
ok=1; start_service || ok=0
[ "${DRY_RUN:-0}" = 1 ] && exit 0
[ "$MODE" = complete ] && record_update "$OLD $(cat "$O_APP/VERSION" 2>/dev/null || echo ?) (build $(cat "$O_APP/BUILD" 2>/dev/null || echo ?))"
log "Vérifications"
chk() { if [ "$2" = "$3" ]; then echo "  OK   $1 : ${2:-(vide)}"; else echo "  ÉCART $1 : avant « $2 », après « $3 »"; ok=0; fi; }
chk PUBLIC_URL "$O_URL" "$(env_get PUBLIC_URL)"
chk TRUSTED_PROXIES "$O_TRUST" "$(env_get TRUSTED_PROXIES)"
chk ALLOW_FROM "$O_ALLOW" "$(env_get ALLOW_FROM)"
chk ADMIN_ALLOW_CIDR "$O_CIDR" "$(env_get ADMIN_ALLOW_CIDR)"
chk PORT "${O_PORT:-8790}" "$(env_get PORT)"
port=$(env_get PORT); port=${port:-$DEFAULT_PORT}
h=$(curl -fsS -m 3 "http://127.0.0.1:$port/healthz" 2>/dev/null || true); echo "  /healthz : ${h:-AUCUNE RÉPONSE}"; [ -n "$h" ] || ok=0
for u in $N_UNITS; do printf '  %-28s %s / %s\n' "$u" "$(systemctl is-enabled "$u" 2>/dev/null || true)" "$(systemctl is-active "$u" 2>/dev/null || true)"; done
if [ $ok = 1 ]; then touch "$MARK"; chown "$APP_USER:$APP_USER" "$MARK"; fi
cat <<FIN

================ Résumé ================
ChatSysVisio $(cat "$APP_DIR/VERSION") (build $(cat "$APP_DIR/BUILD")) $( [ $ok = 1 ] && echo "en service" || echo "À VÉRIFIER (voir ci-dessus ; retour arrière : bash rollback.sh)")
  service : systemctl status chatsysvisio · journal : journalctl -u chatsysvisio -f
  config  : $ENV_FILE (reprise de $O_ENV)   ·   données : $DATA_DIR
  CLI     : chatsysvisio-admin (alias $OLD-admin conservé)
  sauvegarde : $BK
  ancienne installation laissée en place (arrêtée) : $O_APP, $O_ETC, $O_DATA

Ce qui change pour les utilisateurs :
  - tout le monde recharge la page une fois : Ctrl+F5 (Cmd+Maj+R sur Mac ; fermer / rouvrir l'onglet sur mobile) ;
  - administration : nouvelle connexion (mêmes identifiant, mot de passe et application TOTP ; nouveau cookie
    __Host-csv_admin) ; comptes utilisateurs : reconnexion avec le même mot de passe (cookie __Host-csv_sid) ;
  - salons, liens d'invitation et salons chiffrés de bout en bout : inchangés (étiquette E2EE d'origine conservée) ;
  - adresse, port $port, Nginx Proxy Manager : rien à changer.
FIN
[ $ok = 1 ]
