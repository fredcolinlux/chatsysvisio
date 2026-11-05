#!/bin/bash
# Appelé par apt après chaque installation (/etc/apt/apt.conf.d/99chatsysvisio) : si Node.js a été mis à jour
# (ex. correctif de sécurité via unattended-upgrades), redémarre ChatSysVisio pour qu'il tourne sur la version corrigée.
systemctl is-active -q chatsysvisio.service || exit 0
node_bin=$(readlink -f /usr/bin/node 2>/dev/null) || exit 0
node_t=$(stat -c %Y "$node_bin" 2>/dev/null) || exit 0
start=$(systemctl show -p ActiveEnterTimestamp --value chatsysvisio.service)
start_t=$(date -d "$start" +%s 2>/dev/null) || exit 0
if [ "$node_t" -gt "$start_t" ]; then
  logger -t chatsysvisio "Node.js mis à jour : redémarrage de chatsysvisio"
  systemctl restart chatsysvisio.service || true
fi
exit 0
