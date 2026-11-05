#!/usr/bin/env bash
# chatsysvisio-status — relevé de l'état système pour la page d'administration (lancé par systemd, en root) :
# sauvegardes présentes, mises à jour Debian en attente, dernier passage d'unattended-upgrades, dernière mise à jour
# de ChatSysVisio. Écrit DATA_DIR/system-status.json (propriété chatsysvisio, 0600). Ne modifie rien d'autre.
# Le service chatsysvisio (non root) ne lit jamais /var/backups ni apt : il lit seulement ce fichier.
set -euo pipefail
DATA=${DATA_DIR:-/var/lib/chatsysvisio}; DEST=${BACKUP_DIR:-/var/backups/chatsysvisio}; KEEP=${KEEP_DAYS:-14}
rm -f "$DATA/requests/status"
UPG=$(LC_ALL=C apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst ' || true)
DATA="$DATA" DEST="$DEST" KEEP="$KEEP" UPG="$UPG" python3 - <<'PY'
import json, os, glob, time, re, subprocess, tempfile
data, dest = os.environ['DATA'], os.environ['DEST']
ms = lambda t: int(t * 1000)
backups = []
for f in sorted(glob.glob(os.path.join(dest, 'chatsysvisio-*.tar.gz')), key=os.path.getmtime, reverse=True)[:60]:
    st = os.stat(f); backups.append({'name': os.path.basename(f), 'size': st.st_size, 'at': ms(st.st_mtime)})
pk, sec = [], 0
for l in os.environ.get('UPG', '').splitlines():
    m = re.match(r'Inst (\S+)', l)
    if m: pk.append(m.group(1)); sec += 1 if re.search(r'-security|Debian-Security', l) else 0
un = {'enabled': False, 'lastRun': 0}
try: un['enabled'] = bool(re.search(r'Unattended-Upgrade\s+"1"', open('/etc/apt/apt.conf.d/20auto-upgrades').read()))
except OSError: pass
for f in ['/var/log/unattended-upgrades/unattended-upgrades.log', '/var/lib/apt/periodic/unattended-upgrades-stamp']:
    try: un['lastRun'] = max(un['lastRun'], ms(os.path.getmtime(f)))
    except OSError: pass
last = None
try: last = json.load(open(os.path.join(data, 'last-update.json')))
except (OSError, ValueError): pass
out = {'at': ms(time.time()), 'backups': backups, 'backupDir': dest, 'keepDays': int(os.environ['KEEP']),
       'updates': {'count': len(pk), 'security': sec, 'packages': pk[:200]}, 'unattended': un, 'lastAppUpdate': last}
st = os.stat(data)
fd, tmp = tempfile.mkstemp(dir=data, prefix='.system-status.')
with os.fdopen(fd, 'w') as fh: json.dump(out, fh)
os.chmod(tmp, 0o600); os.chown(tmp, st.st_uid, st.st_gid); os.replace(tmp, os.path.join(data, 'system-status.json'))
print(f"état : {len(backups)} sauvegarde(s), {len(pk)} mise(s) à jour en attente ({sec} de sécurité)")
PY
