#!/usr/bin/env bash
# Fonctions communes à install.sh (installation neuve) et update.sh (mise à jour) de ChatSysVisio.
# Chemins surchargeables (tests uniquement).
APP_DIR=${APP_DIR:-/opt/chatsysvisio}
DATA_DIR=${DATA_DIR:-/var/lib/chatsysvisio}
ETC_DIR=${ETC_DIR:-/etc/chatsysvisio}
ENV_FILE=$ETC_DIR/chatsysvisio.env
BACKUP_DIR=${BACKUP_DIR:-/var/backups/chatsysvisio}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
APP_USER=chatsysvisio
DEFAULT_PORT=8790
DEFAULT_PUBLIC_URL="https://chat.example.com"
DEFAULT_NPM_IP="10.0.0.10"
DEFAULT_OLLA_URL="http://10.0.0.50:11434"
# Paquet autonome : Node.js officiel embarqué (runtime/), installé dans NODE_HOME, hors du dossier du code.
NODE_HOME=${NODE_HOME:-/opt/chatsysvisio-node}
if [ -z "${NODE_BIN:-}" ]; then if [ -x "$NODE_HOME/bin/node" ]; then NODE_BIN=$NODE_HOME/bin/node; else NODE_BIN=/usr/bin/node; fi; fi

log()  { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33mATTENTION :\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31mERREUR :\033[0m %s\n' "$*" >&2; exit 1; }
ask() { # ask VAR "question" défaut   (variable déjà définie dans l'environnement = pas de question)
  local __v=$1 q=$2 d=$3 cur="${!1:-}"
  if [ -n "$cur" ]; then return; fi
  if [ "${NONINTERACTIVE:-0}" = 1 ]; then printf -v "$__v" '%s' "$d"; return; fi
  local ans=""; read -r -p "$q [$d] : " ans </dev/tty || true
  printf -v "$__v" '%s' "${ans:-$d}"
}
require_root() { [ "$(id -u)" -eq 0 ] || die "À lancer en root."; }
check_os() { . /etc/os-release; [ "${VERSION_CODENAME:-}" = "trixie" ] || warn "prévu pour Debian 13 (trixie), détecté : ${PRETTY_NAME:-inconnu}."; }
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0; }
# DRY_RUN=1 : affiche les commandes système au lieu de les exécuter (test à blanc).
run() { if [ "${DRY_RUN:-0}" = 1 ]; then echo "  [à blanc] $*"; else "$@"; fi; }

# Installe le Node.js embarqué (vérifié par SHA256) : aucune connexion réseau nécessaire.
install_bundled_node() {
  local a; case "$(uname -m)" in x86_64|amd64) a=x64;; aarch64|arm64) a=arm64;; *) die "architecture $(uname -m) non prise en charge par le Node embarqué (USE_SYSTEM_NODE=1 pour Node des dépôts)";; esac
  local tb; tb=$(ls "$SRC"/runtime/node-v*-linux-$a.tar.xz 2>/dev/null | head -n1)
  [ -n "$tb" ] || die "Node embarqué absent pour linux-$a (runtime/)"
  log "Node.js embarqué $(basename "$tb") -> $NODE_HOME"
  ( cd "$SRC/runtime" && grep " $(basename "$tb")\$" SHASUMS256.txt | sha256sum -c --status ) || die "empreinte SHA256 du Node embarqué invalide"
  echo "  SHA256 vérifié (SHASUMS256.txt officiel de nodejs.org)"
  if [ "${DRY_RUN:-0}" = 1 ]; then echo "  [à blanc] extraction dans $NODE_HOME"; NODE_BIN=$NODE_HOME/bin/node; return; fi
  rm -rf "$NODE_HOME.new"; install -d -m 0755 "$NODE_HOME.new"
  tar -C "$NODE_HOME.new" --strip-components=1 --no-same-owner -xJf "$tb"
  rm -rf "$NODE_HOME.prev"; [ -d "$NODE_HOME" ] && mv "$NODE_HOME" "$NODE_HOME.prev"; mv "$NODE_HOME.new" "$NODE_HOME"
  chown -R root:root "$NODE_HOME"; chmod -R go-w "$NODE_HOME"
  NODE_BIN=$NODE_HOME/bin/node
  [ -e /usr/bin/node ] || [ -e /usr/local/bin/node ] || ln -s "$NODE_BIN" /usr/local/bin/node
  echo "  Node $("$NODE_BIN" -v)"
}

install_packages() {
  if [ -d "$SRC/runtime" ] && [ "${USE_SYSTEM_NODE:-0}" != 1 ]; then install_bundled_node; return; fi
  log "Paquets système (Node.js 20 des dépôts Debian, curl, python3 pour le rapport WebGuardian)"
  export DEBIAN_FRONTEND=noninteractive
  if [ "${DRY_RUN:-0}" = 1 ]; then echo "  [à blanc] apt-get install nodejs ca-certificates curl python3 tar gzip (+ unattended-upgrades si UNATTENDED=1)"; return; fi
  local i; for i in 1 2 3; do apt-get update -qq && break; warn "apt-get update a échoué (essai $i/3)"; sleep 5; done
  apt-get install -y -qq --no-install-recommends ca-certificates curl python3 tar gzip nodejs >/dev/null
  if [ "${UNATTENDED:-1}" = 1 ]; then
    # Correctifs de sécurité Debian automatiques (dont nodejs) ; config Debian par défaut = dépôt security uniquement
    apt-get install -y -qq --no-install-recommends unattended-upgrades >/dev/null || warn "unattended-upgrades non installé"
    [ -f /etc/apt/apt.conf.d/20auto-upgrades ] || printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
    echo "  mises à jour de sécurité automatiques : activées"
  fi
  NODE_BIN=$(command -v node || echo /usr/bin/node)
  [ "$(node_major)" -ge 20 ] || die "Node.js >= 20 requis (trouvé : $(node -v 2>/dev/null || echo aucun))."
  echo "  Node $(node -v)"
}

ensure_user() {
  log "Utilisateur système $APP_USER (sans shell ni connexion)"
  id "$APP_USER" >/dev/null 2>&1 || run useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$APP_USER"
  run install -d -m 0750 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR"
  # demandes de l'administration (sauvegarde, actualisation de l'état) surveillées par systemd (.path)
  run install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$DATA_DIR/requests"
  run install -d -m 0711 -o root -g root "$ETC_DIR"
}

# Copie le code ($1) dans APP_DIR. Aucune dépendance téléchargée : l'archive contient node_modules (ws) et public/vendor.
deploy_code() {
  local src=$1
  log "Code -> $APP_DIR"
  [ -f "$src/server/index.mjs" ] || die "sources introuvables dans $src"
  [ -f "$src/node_modules/ws/package.json" ] || die "node_modules/ws absent de l'archive (archive incomplète ?)"
  [ -f "$src/public/vendor/mediapipe/vision_bundle.mjs" ] || warn "public/vendor absent : flou et arrière-plans indisponibles (lancer npm ci && npm run vendor)."
  [ -f "$src/public/vendor/rnnoise/rnnoise-worklet.js" ] || warn "public/vendor/rnnoise absent : réduction de bruit du micro indisponible (lancer npm ci && npm run vendor)."
  run install -d -m 0755 -o root -g root "$APP_DIR"
  if [ "${DRY_RUN:-0}" = 1 ]; then echo "  [à blanc] copie de $src vers $APP_DIR"; return; fi
  tar -C "$src" --exclude=./data --exclude=./test-results --exclude=./playwright-report --exclude=./.git -cf - . | tar -C "$APP_DIR" -xf -
  # code en lecture seule pour le service : propriété root, lisible par tous
  chown -R root:root "$APP_DIR"; chmod -R u=rwX,go=rX "$APP_DIR"
  # Archive des sources (AGPL §13) servie sur /source.tar.gz — sans node_modules ni fichiers tiers compilés.
  tar -C "$src" --exclude=./node_modules --exclude=./public/vendor --exclude=./data --exclude=./test-results \
      --exclude=./playwright-report --exclude=./source.tar.gz --exclude=./.git -czf "$APP_DIR/source.tar.gz" . && chmod 0644 "$APP_DIR/source.tar.gz"
  ( cd "$APP_DIR" && "$NODE_BIN" -e "import('./server/app.mjs').then(()=>console.log('  modules OK'))" ) || die "le serveur ne se charge pas"
}

env_get() { sed -n "s/^[[:space:]]*$1=//p" "$ENV_FILE" 2>/dev/null | tail -n1 | sed "s/^'\(.*\)'$/\1/; s/^\"\(.*\)\"$/\1/"; }
env_set_default() { # clé valeur [commentaire] : ajoute la clé seulement si absente (les valeurs existantes sont conservées)
  grep -q "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null && return 0
  { [ -n "${3:-}" ] && echo "# $3"; printf "%s='%s'\n" "$1" "$2"; } >> "$ENV_FILE"
  echo "  + $1 ajouté"
}

write_env() {
  log "Configuration $ENV_FILE"
  ask PUBLIC_URL "Adresse publique (derrière Nginx Proxy Manager)" "$DEFAULT_PUBLIC_URL"
  ask NPM_IP "Adresse IP de Nginx Proxy Manager (proxy de confiance)" "$DEFAULT_NPM_IP"
  ask RESTRICT "N'accepter les connexions que depuis NPM (recommandé) ? (o/n)" "o"
  ask PORT "Port d'écoute local" "$DEFAULT_PORT"
  ask ANON "Création de salon anonyme (sans compte) ? (o/n)" "o"
  ask AI "Activer le résumé par l'assistant local Olla ? (o/n)" "n"
  local allow="" anon=true ai=false
  case "$RESTRICT" in [oOyY]*) allow=$NPM_IP;; esac
  case "$ANON" in [nN]*) anon=false;; esac
  case "$AI" in [oOyY]*) ai=true; ask OLLA_URL "URL d'Olla (API Ollama)" "$DEFAULT_OLLA_URL";; esac
  if [ "${DRY_RUN:-0}" = 1 ]; then echo "  [à blanc] écriture de $ENV_FILE (PUBLIC_URL=$PUBLIC_URL, TRUSTED_PROXIES=127.0.0.1,::1,$NPM_IP, ALLOW_FROM=$allow, PORT=$PORT, ALLOW_ANON_CREATE=$anon, AI_ENABLED=$ai)"; return; fi
  ( umask 077; cat > "$ENV_FILE" <<ENVEOF
# ChatSysVisio — configuration (root:root 0600). Modifier puis : systemctl restart chatsysvisio
PORT='$PORT'
HOST='0.0.0.0'
PUBLIC_URL='$PUBLIC_URL'
TRUSTED_PROXIES='127.0.0.1,::1,$NPM_IP'
# Vide = toute adresse peut joindre le port ; sinon seulement ces IP (+ la machine elle-même)
ALLOW_FROM='$allow'
DATA_DIR='$DATA_DIR'
MAX_PARTICIPANTS='25'
ROOM_TTL_DAYS='30'
UPLOAD_MAX_MB='10'
# Espace disque max des fichiers d'un salon (Mo) et nombre max de salons
ROOM_QUOTA_MB='200'
MAX_ROOMS='5000'
# Débits vidéo (kbit/s) : vignette, grande image, partage d'écran
VIDEO_LO_KBPS='70'
VIDEO_HI_KBPS='450'
SCREEN_KBPS='900'
# HD (1.1) : couche 720p / 1080p (envoyée seulement à qui affiche la personne en grand), partage d'écran 1080p
VIDEO_720_KBPS='1200'
VIDEO_1080_KBPS='2500'
SCREEN_HD_KBPS='1500'
# Hauteur vidéo maximale acceptée par le serveur : 360, 720 ou 1080
VIDEO_MAX_HEIGHT='1080'
# Débit média max reçu d'une personne (kbit/s, au-delà les images vidéo sont abandonnées)
MEDIA_MAX_KBPS='20000'
AUDIO_TOP_N='4'
ALLOW_ANON_CREATE='$anon'
# Si ALLOW_ANON_CREATE=false : empreinte du code de création (printf '%s' 'code' | node $APP_DIR/scripts/hash-password.mjs)
CREATE_PASSWORD_HASH=''
AI_ENABLED='$ai'
OLLA_URL='${OLLA_URL:-}'
OLLA_MODEL='qwen3:14b'
# Contact sécurité publié dans /.well-known/security.txt (ex. mailto:moi@exemple.fr) ; vide = non publié
SECURITY_CONTACT=''
# --- Administration (1.2) --- page réservée au réseau local ; compte : chatsysvisio-admin create-admin
ADMIN_PATH='/admin'
# Réseaux autorisés (adresse réelle du client ; X-Forwarded-For n'est cru que venant de TRUSTED_PROXIES). Autres : 404.
ADMIN_ALLOW_CIDR='127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10'
# HTTP en clair autorisé hors boucle locale (déconseillé : préférer HTTPS via NPM ou un tunnel SSH)
ADMIN_ALLOW_HTTP='false'
# --- Comptes (facultatifs, modifiables à chaud dans l'administration) ---
# Inscriptions : closed, open, invite (code d'invitation) ou approval (validation par l'admin)
SIGNUP_MODE='closed'
ACCOUNTS_ONLY_CREATE='false'
GUEST_JOIN='true'
ENVEOF
  )
  chown root:root "$ENV_FILE"; chmod 0600 "$ENV_FILE"
}

# Ajoute les clés introduites par les nouvelles versions, sans toucher aux valeurs existantes.
migrate_env() {
  log "Migration de la configuration (valeurs existantes conservées)"
  [ -f "$ENV_FILE" ] || die "$ENV_FILE absent"
  [ "${DRY_RUN:-0}" = 1 ] && { echo "  [à blanc] migration de $ENV_FILE"; return; }
  env_set_default ALLOW_FROM "" "Vide = toute adresse ; sinon seulement ces IP (+ locale)"
  env_set_default AUDIO_TOP_N "4"
  env_set_default SECURITY_CONTACT "" "Contact publié dans /.well-known/security.txt"
  env_set_default ROOM_QUOTA_MB "200" "Espace disque max des fichiers d'un salon (Mo)"
  env_set_default MAX_ROOMS "5000" "Nombre max de salons"
  env_set_default VIDEO_720_KBPS "1200" "HD 720p (kbit/s)"
  env_set_default VIDEO_1080_KBPS "2500" "HD 1080p (kbit/s)"
  env_set_default SCREEN_HD_KBPS "1500" "Partage d'écran 1080p (kbit/s)"
  env_set_default VIDEO_MAX_HEIGHT "1080" "Hauteur vidéo max : 360, 720 ou 1080"
  env_set_default MEDIA_MAX_KBPS "20000" "Débit média max reçu d'une personne (kbit/s)"
  env_set_default ADMIN_PATH "/admin" "Administration (1.2) : chemin de la page, réservée au réseau local"
  env_set_default ADMIN_ALLOW_CIDR "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,fe80::/10" "Réseaux autorisés pour l'administration (autres : 404)"
  env_set_default ADMIN_ALLOW_HTTP "false" "Administration en HTTP clair hors boucle locale (déconseillé)"
  env_set_default SIGNUP_MODE "closed" "Comptes : closed, open, invite ou approval"
  env_set_default ACCOUNTS_ONLY_CREATE "false" "Création de salons réservée aux comptes"
  env_set_default GUEST_JOIN "true" "Invités sans compte autorisés à rejoindre par lien"
  chmod 0600 "$ENV_FILE"
}

install_units() {
  local src=$1
  log "Services systemd"
  for u in chatsysvisio.service chatsysvisio-backup.service chatsysvisio-backup.timer chatsysvisio-backup.path \
           chatsysvisio-status.service chatsysvisio-status.timer chatsysvisio-status.path; do
    run install -m 0644 "$src/deploy/$u" "$SYSTEMD_DIR/$u"
    # dossier de données non standard : chemins surveillés adaptés
    [ "${DRY_RUN:-0}" = 1 ] || [ "$NODE_BIN" = /usr/bin/node ] || sed -i "s#/usr/bin/node #$NODE_BIN #g" "$SYSTEMD_DIR/$u"
    [ "${DRY_RUN:-0}" = 1 ] || [ "$DATA_DIR" = /var/lib/chatsysvisio ] || sed -i "s#/var/lib/chatsysvisio#$DATA_DIR#g" "$SYSTEMD_DIR/$u"
  done
  run install -m 0755 "$src/deploy/backup.sh" /usr/local/sbin/chatsysvisio-backup
  run install -m 0755 "$src/deploy/status.sh" /usr/local/sbin/chatsysvisio-status
  if [ "${DRY_RUN:-0}" = 1 ]; then echo "  [à blanc] /usr/local/sbin/chatsysvisio-admin"; else
    cat > /usr/local/sbin/chatsysvisio-admin <<WRAP
#!/bin/sh
# Gestion des administrateurs de ChatSysVisio (voir README-INSTALL.md)
[ "\$(id -u)" -eq 0 ] || { echo "À lancer en root (sudo chatsysvisio-admin ...)" >&2; exit 1; }
ADMIN_PATH=\$(sed -n "s/^ADMIN_PATH='\\(.*\\)'\\\$/\\1/p" "$ENV_FILE" 2>/dev/null)
export ADMIN_PATH
exec "$NODE_BIN" "$APP_DIR/scripts/chatsysvisio-admin.mjs" --data-dir "$DATA_DIR" "\$@"
WRAP
    chmod 0755 /usr/local/sbin/chatsysvisio-admin
  fi
  run install -m 0755 "$src/deploy/node-restart-check.sh" /usr/local/sbin/chatsysvisio-node-check
  if [ "${DRY_RUN:-0}" != 1 ]; then
    echo 'DPkg::Post-Invoke { "if [ -x /usr/local/sbin/chatsysvisio-node-check ]; then /usr/local/sbin/chatsysvisio-node-check; fi"; };' > /etc/apt/apt.conf.d/99chatsysvisio
  fi
  run systemctl daemon-reload
  run systemctl enable --now chatsysvisio-backup.timer >/dev/null 2>&1 || true
  run systemctl enable --now chatsysvisio-backup.path chatsysvisio-status.path chatsysvisio-status.timer >/dev/null 2>&1 || true
  run systemctl start --no-block chatsysvisio-status.service >/dev/null 2>&1 || true
}

# Propose de créer le compte administrateur s'il n'en existe aucun (jamais de mot de passe par défaut).
admin_setup() {
  [ "${DRY_RUN:-0}" = 1 ] && { echo "  [à blanc] chatsysvisio-admin create-admin (si aucun administrateur)"; return 0; }
  [ -s "$DATA_DIR/admin.json" ] && grep -q '"user"' "$DATA_DIR/admin.json" 2>/dev/null && { echo "  administrateur déjà configuré (chatsysvisio-admin list)"; return 0; }
  if [ "${NONINTERACTIVE:-0}" = 1 ] || { [ ! -t 0 ] && [ ! -r /dev/tty ]; }; then
    echo "  aucun administrateur : le créer plus tard avec  chatsysvisio-admin create-admin"; return 0
  fi
  log "Compte administrateur (page $(env_get ADMIN_PATH), réseau local uniquement)"
  local a=""; read -r -p "Créer le compte administrateur maintenant (mot de passe + application TOTP) ? [O/n] " a </dev/tty || true
  case "${a:-O}" in [nN]*) echo "  plus tard : chatsysvisio-admin create-admin"; return 0;; esac
  /usr/local/sbin/chatsysvisio-admin create-admin </dev/tty || warn "création annulée : relancer chatsysvisio-admin create-admin"
}

# Date et versions de la dernière mise à jour (affichées dans l'administration)
record_update() {
  [ "${DRY_RUN:-0}" = 1 ] && return 0
  local from=$1 to; to="$(cat "$APP_DIR/VERSION" 2>/dev/null || echo ?) (build $(cat "$APP_DIR/BUILD" 2>/dev/null || echo ?))"
  ( umask 077; printf '{"at":%s000,"from":"%s","to":"%s"}\n' "$(date +%s)" "$from" "$to" > "$DATA_DIR/last-update.json" )
  chown "$APP_USER:$APP_USER" "$DATA_DIR/last-update.json" 2>/dev/null || true
}

start_service() {
  log "Démarrage"
  run systemctl enable chatsysvisio.service >/dev/null 2>&1 || true
  run systemctl restart chatsysvisio.service
  [ "${DRY_RUN:-0}" = 1 ] && return 0
  local port; port=$(env_get PORT); port=${port:-$DEFAULT_PORT}
  local i; for i in $(seq 1 30); do { if command -v curl >/dev/null; then curl -fsS -m 2 "http://127.0.0.1:$port/healthz"; else "$NODE_BIN" -e "fetch('http://127.0.0.1:$port/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"; fi; } >/dev/null 2>&1 && { echo "  service OK sur le port $port"; return 0; }; sleep 1; done
  warn "le service ne répond pas : journalctl -u chatsysvisio -n 50"
  return 1
}

summary() {
  local port pub; port=$(env_get PORT); pub=$(env_get PUBLIC_URL)
  cat <<SUM

ChatSysVisio $(cat "$APP_DIR/VERSION" 2>/dev/null) (build $(cat "$APP_DIR/BUILD" 2>/dev/null || echo ?)) est installé.
  Service      : systemctl status chatsysvisio   ·   journal : journalctl -u chatsysvisio -f
  Écoute       : 0.0.0.0:${port:-$DEFAULT_PORT} (HTTP + WebSocket, à publier via NPM sur 443 uniquement)
  Config       : $ENV_FILE
  Données      : $DATA_DIR      ·   sauvegardes : $BACKUP_DIR (chaque nuit, 14 jours)
  Adresse      : ${pub:-non définie}
  NPM          : voir README-INSTALL.md (Websockets Support activé, Force SSL, HSTS désactivé côté NPM)
  Admin        : http(s)://<serveur>$(env_get ADMIN_PATH) depuis le réseau local · compte : chatsysvisio-admin create-admin
SUM
}
