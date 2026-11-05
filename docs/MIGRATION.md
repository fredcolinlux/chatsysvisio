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

Conséquences : les sessions en cours sont fermées (nouvelle connexion à l'administration et aux comptes) et tout le
monde recharge la page (**Ctrl+F5**). Sans `E2EE_LABEL` (migration manuelle), les salons chiffrés existants deviennent
illisibles ; la procédure automatique le règle.

## Procédure automatique (recommandée)

Depuis le dossier extrait de l'archive ChatSysVisio, en root :

```bash
OLD_NAME=ancien-nom bash deploy/migrate-from.sh        # DRY_RUN=1 pour un essai à blanc
```

Le script : sauvegarde complète (code, configuration, données, unités, CLI) dans `/var/backups/chatsysvisio-migration`,
arrête et désactive les anciennes unités, reprend **à l'identique** la configuration (seuls les chemins changent ; les
valeurs implicites de l'ancien code — proxys de confiance, réseaux d'administration — sont rendues explicites ; l'étiquette
E2EE d'origine est conservée dans `E2EE_LABEL`), copie les données (l'original reste intact), installe et démarre les
unités `chatsysvisio*`, remplace la CLI (l'ancien nom reste un alias qui redirige), puis vérifie `/healthz` et la
configuration. Relançable sans dommage. Retour arrière :

```bash
OLD_NAME=ancien-nom bash deploy/rollback-migration.sh   # ROLLBACK_DATA=origine : données d'avant la migration
```

Avec `E2EE_LABEL`, les salons chiffrés de bout en bout existants (mot de passe, contrôle de clé, historique, fichiers)
restent lisibles : **rien ne change pour les liens**. Restent à faire par chacun : Ctrl+F5 et reconnexion (nouveaux cookies).

## Procédure manuelle


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
