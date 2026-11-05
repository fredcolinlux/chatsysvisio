# Migration vers ChatSysVisio (depuis l'ancien nom du projet)

ChatSysVisio 1.5.1 est le même logiciel que la version 1.5.1 précédente, renommé. Les chemins, services et cookies
changent ; les données et la configuration se reprennent telles quelles.

| Élément | Ancien (`<ancien>` = nom court précédent) | Nouveau |
|---|---|---|
| Code | `/opt/<ancien>` | `/opt/chatsysvisio` |
| Données | `/var/lib/<ancien>` | `/var/lib/chatsysvisio` |
| Configuration | `/etc/<ancien>/<ancien>.env` | `/etc/chatsysvisio/chatsysvisio.env` |
| Sauvegardes | `/var/backups/<ancien>` | `/var/backups/chatsysvisio` |
| Services | `<ancien>.service`, `-backup`, `-status` | `chatsysvisio.service`, `chatsysvisio-backup.*`, `chatsysvisio-status.*` |
| Utilisateur système | `<ancien>` | `chatsysvisio` |
| CLI | `<ancien>-admin` | `chatsysvisio-admin` |
| Cookies | `__Host-cc_sid`, `__Host-cc_admin` | `__Host-csv_sid`, `__Host-csv_admin` |
| Dérivation E2EE | étiquette `<ancien>/e2ee/v1` | `chatsysvisio/e2ee/v1` |

Conséquences : les sessions en cours sont fermées (nouvelle connexion à l'administration), et un ancien client ne peut
pas rejoindre un salon chiffré servi par ChatSysVisio : tout le monde recharge la page (**Ctrl+F5**).

## Procédure (dans le CT, en root)

```bash
OLD=ancien-nom                       # nom court de l'ancienne installation
systemctl disable --now $OLD $OLD-backup.timer $OLD-backup.path $OLD-status.timer $OLD-status.path
tar -czf /root/avant-migration.tar.gz /etc/$OLD /var/lib/$OLD          # sauvegarde de sécurité
tar -xzf chatsysvisio-1.5.1.tar.gz && cd chatsysvisio-1.5.1
NONINTERACTIVE=1 PUBLIC_URL=https://chat.example.com NPM_IP=10.0.0.10 bash install.sh
systemctl stop chatsysvisio
cp -a /var/lib/$OLD/. /var/lib/chatsysvisio/ && chown -R chatsysvisio:chatsysvisio /var/lib/chatsysvisio
# reprendre vos réglages : comparer puis recopier les valeurs utiles
diff /etc/$OLD/$OLD.env /etc/chatsysvisio/chatsysvisio.env
sed -i "s#/var/lib/$OLD#/var/lib/chatsysvisio#g" /etc/chatsysvisio/chatsysvisio.env
systemctl start chatsysvisio && curl -s http://127.0.0.1:8790/healthz
```

Une fois tout vérifié :

```bash
rm -f /etc/systemd/system/$OLD* /usr/local/sbin/$OLD-* /etc/apt/apt.conf.d/99$OLD && systemctl daemon-reload
userdel $OLD; rm -rf /opt/$OLD /opt/$OLD.prev     # garder /var/lib/$OLD et /etc/$OLD quelques jours
```

Rien à changer dans Nginx Proxy Manager si le port (8790) et l'IP du CT restent les mêmes. Les salons chiffrés
de bout en bout existants restent utilisables après rechargement des pages.
