#!/usr/bin/env bash
# Contrôle de sécurité après installation / mise à jour de ChatSysVisio (n'interrompt jamais l'installation).
#  1. en local : liste de contrôle des en-têtes (scripts/check-headers.mjs), en HTTP puis en HTTPS simulé (comme derrière NPM)
#  2. si PUBLIC_URL est défini : scan public WebGuardian (https://webguardian.cloud) du domaine exposé
# Usage (root) : bash deploy/security-scan.sh [/etc/chatsysvisio/chatsysvisio.env]   ·   SECURITY_SCAN=0 : pas de scan public
set -uo pipefail
ENVF=${1:-/etc/chatsysvisio/chatsysvisio.env}
APP=${APP_DIR:-/opt/chatsysvisio}
getv() { [ -r "$ENVF" ] && sed -n "s/^$1=//p" "$ENVF" | tail -1 | tr -d "\"'" || true; }
PORT=$(getv PORT); PORT=${PORT:-8790}
PUB=$(getv PUBLIC_URL)
LOG=/var/log/chatsysvisio-security-scan.log
UA="Mozilla/5.0 (X11; Linux x86_64) ChatSysVisioSecurityCheck/1.0"
echo "== Contrôle de sécurité de ChatSysVisio ($(date '+%F %T'))"

# 1. Local
up=0; for i in $(seq 1 20); do curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null && { up=1; break; }; sleep 1; done
if [ $up = 0 ]; then echo "  [local] service injoignable sur le port $PORT : contrôle sauté"
else
  node "$APP/scripts/check-headers.mjs" "http://127.0.0.1:$PORT" --https | sed 's/^/  [local] /'
  [ "${PIPESTATUS[0]}" = 0 ] || echo "  [local] des contrôles ont échoué (voir ci-dessus)"
fi

# 2. Public (WebGuardian)
if [ "${SECURITY_SCAN:-1}" = "0" ]; then echo "  [public] scan désactivé (SECURITY_SCAN=0)"; exit 0; fi
host=$(printf '%s' "$PUB" | sed -E 's#^[a-z]+://##; s#[/:].*$##')
if [ -z "$host" ]; then echo "  [public] PUBLIC_URL non défini : pas de scan WebGuardian"; exit 0; fi
pc=$(curl -s -m 15 -o /dev/null -w '%{http_code}' "https://$host/healthz" 2>/dev/null || echo 000)
[ "$pc" = 200 ] || echo "  [public] https://$host/healthz répond $pc (NPM pas encore configuré ?) — le scan peut être incomplet"
sleep 3
tmp=$(mktemp); trap 'rm -f "$tmp"' EXIT
code=$(curl -sL -m 90 -A "$UA" -o "$tmp" -w '%{http_code}' "https://webguardian.cloud/en/scanner/analyze?host=$host" 2>/dev/null || echo 000)
if [ "$code" != "200" ]; then echo "  [public] WebGuardian indisponible (HTTP $code) : relancez plus tard avec bash $0"; exit 0; fi
python3 - "$tmp" "$host" <<'PY' | { tee -a "$LOG" 2>/dev/null || cat; }
import re, html, sys
s = open(sys.argv[1], encoding="utf-8", errors="replace").read()
t = re.sub(r"<script.*?</script>|<style.*?</style>", "", s, flags=re.S)
t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", t)))
g = re.search(r"([A-F][+-]?) Overall grade\s*[—-]\s*(\d+)/100", t)
print(f"  [public] WebGuardian {sys.argv[2]} : " + (f"note {g.group(1)}, {g.group(2)}/100" if g else "note introuvable (format du rapport changé ?)"))
bad = [(m.group(1).strip(), m.group(2), m.group(3), m.group(4), m.group(5))
       for m in re.finditer(r"([A-Z][A-Za-z0-9 ()/,'-]{3,80}?) (\d+)/(\d+) pts (Critical|High|Medium|Low|Info) (\w+)", t)
       if m.group(2) != m.group(3)]
for n, a, b, sev, st in bad: print(f"  [public] À corriger : {n} — {a}/{b} pts ({sev}, {st})")
if g and not bad: print("  [public] aucun point perdu")
print(f"  [public] rapport : https://webguardian.cloud/en/scanner/report/{sys.argv[2]}")
PY
exit 0
