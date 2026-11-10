# ChatSysVisio — installation (Debian 13, CT LXC non privilégié, derrière Nginx Proxy Manager)

ChatSysVisio n'utilise **que le port TCP 443** côté Internet : la page, l'API **et la vidéo/le son** passent par la même
connexion HTTPS/WebSocket que Nginx Proxy Manager (NPM) relaie vers le CT. Pas d'UDP, pas de TURN, aucun autre port.

## 1. Le CT

- Proxmox : CT **Debian 13 (trixie)**, **non privilégié**, 2 vCPU, 1 Go de RAM, 8 Go de disque suffisent pour 25 personnes.
- Une IP fixe sur le LAN (exemple ci-dessous : `10.0.0.20`). Aucune option « nesting » ni périphérique nécessaire.
- Le CT a besoin d'accéder aux dépôts Debian (pour `nodejs`) pendant l'installation. Rien d'autre n'est téléchargé.

## 2. Installation

**Paquet autonome (recommandé, hors ligne)** : `chatsysvisio-<version>.tar.gz` contient Node.js 24 officiel (x64 + arm64,
SHA256 vérifié), les dépendances, MediaPipe et la police : `tar -xzf chatsysvisio-1.7.0.tar.gz && cd chatsysvisio-1.7.0 && bash install.sh`.
Aucun paquet n'est téléchargé (`USE_SYSTEM_NODE=1` pour utiliser `nodejs` de Debian à la place). Pas à pas : `docs/MANUEL.md`.

Archives classiques (Node.js des dépôts Debian) :

Copier l'archive complète (`chatsysvisio-complet-<version>-b<build>.tar.gz`, ex. `chatsysvisio-complet-1.3.1-b8.tar.gz` ;
une copie sans numéro `chatsysvisio-complet.tar.gz` est aussi fournie) dans le CT puis, **en root** :

```bash
tar -xzf chatsysvisio-complet-1.3.1-b8.tar.gz   # nom exact de l'archive copiée (ou chatsysvisio-complet.tar.gz)
cd chatsysvisio
bash install.sh
```

Questions posées (Entrée = valeur proposée) :

| Question | Valeur par défaut |
|---|---|
| Adresse publique | `https://chat.example.com` |
| IP de Nginx Proxy Manager (proxy de confiance) | `10.0.0.10` |
| N'accepter les connexions que depuis NPM | `o` (recommandé : le port 8790 refuse tout le reste du LAN) |
| Port d'écoute local | `8790` |
| Création de salon anonyme | `o` (voir « Comptes » plus bas) |
| Résumé par l'assistant local Olla | `n` (désactivé par défaut) |

Sans questions : `NONINTERACTIVE=1 PUBLIC_URL=https://chat.example.com NPM_IP=10.0.0.10 bash install.sh`  
Test à blanc (ne modifie rien) : `DRY_RUN=1 NONINTERACTIVE=1 bash install.sh`

Ce que fait le script :

- installe `nodejs` (20, dépôts Debian, suivi par l'équipe sécurité Debian), `curl`, `python3` ;
- active les **mises à jour de sécurité automatiques** Debian (`unattended-upgrades`) et redémarre ChatSysVisio quand Node.js est corrigé (`UNATTENDED=0` pour ne pas les activer) ;
- crée l'utilisateur système `chatsysvisio` (sans shell) ;
- copie le code dans `/opt/chatsysvisio` (propriété root, lecture seule pour le service) ;
- écrit `/etc/chatsysvisio/chatsysvisio.env` (root, 0600) ;
- installe le service durci `chatsysvisio.service` et la sauvegarde quotidienne `chatsysvisio-backup.timer` ;
- installe les unités qui exécutent, **côté systemd et en root**, ce que l'administration demande (le service, lui, reste
  non privilégié et sans sudo) : `chatsysvisio-backup.path` (bouton « Sauvegarder maintenant ») et `chatsysvisio-status.{path,timer,service}`
  (liste des sauvegardes, mises à jour Debian en attente, état d'unattended-upgrades, toutes les heures) ;
- installe la commande `chatsysvisio-admin` et **propose de créer le compte administrateur** (aucun compte ni mot de passe
  par défaut ; ignoré en `NONINTERACTIVE=1` — le créer ensuite avec `chatsysvisio-admin create-admin`) ;
- démarre, puis lance le **contrôle de sécurité** : liste des en-têtes en local, puis scan public **WebGuardian** du domaine.
  Ce contrôle n'est jamais bloquant ; tant que NPM n'est pas configuré, la partie publique échoue simplement.

## 3. Nginx Proxy Manager — réglages exacts

**Hosts → Proxy Hosts → Add Proxy Host** :

Onglet **Details**

| Champ | Valeur |
|---|---|
| Domain Names | `chat.example.com` |
| Scheme | `http` |
| Forward Hostname / IP | `10.0.0.20` (IP du CT ChatSysVisio) |
| Forward Port | `8790` |
| Cache Assets | **désactivé** |
| Block Common Exploits | **activé** |
| Websockets Support | **activé** (indispensable : la vidéo et le son passent par là) |
| Access List | Publicly Accessible |

Onglet **SSL**

| Champ | Valeur |
|---|---|
| SSL Certificate | le certificat Let's Encrypt existant de `chat.example.com` (ou « Request a new SSL Certificate ») |
| Force SSL | **activé** |
| HTTP/2 Support | **activé** |
| HSTS Enabled | **désactivé** (ChatSysVisio envoie lui-même un HSTS conforme : 2 ans, includeSubDomains, preload ; deux en-têtes HSTS feraient perdre des points) |
| HSTS Subdomains | désactivé |

Onglet **Advanced** → *Custom Nginx Configuration* (coller tel quel) :

```nginx
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
proxy_buffering off;
client_max_body_size 12m;
```

- `proxy_read_timeout` / `proxy_send_timeout` : un appel peut durer des heures (sinon NPM coupe le WebSocket après 60 s sans trafic).
- `proxy_buffering off` : les images vidéo ne sont pas retenues par NPM.
- `client_max_body_size 12m` : partage de fichiers jusqu'à 10 Mo dans le chat.

Ne rien ajouter d'autre : **n'ajoutez pas d'en-têtes de sécurité dans NPM**, ChatSysVisio les envoie tous (CSP, HSTS,
X-Frame-Options, COOP/COEP/CORP, Permissions-Policy…). Des doublons feraient baisser la note WebGuardian.

Vérification : `https://chat.example.com/healthz` doit répondre `{"ok":true,…}`, puis relancer le contrôle :

```bash
bash /opt/chatsysvisio/deploy/security-scan.sh
```

Objectif : **A+ 100/100** sur https://webguardian.cloud.

### Durcissement complémentaire (hors note WebGuardian, recommandé)

WebGuardian note uniquement les 8 en-têtes ci-dessus (CSP 22, HSTS 20, X-Frame-Options 13, nosniff 13,
Referrer-Policy 10, Permissions-Policy 10, COOP 9, COEP 3 = 100 pts) ; il affiche aussi la redirection HTTP → HTTPS,
le TLS et les cookies. À régler une fois, hors de ChatSysVisio :

- **NPM** : *Force SSL* activé (redirection 301 du port 80) ; *HSTS Enabled* désactivé (l'appli l'envoie) ; ne pas
  ajouter d'en-têtes ; garder *Block Common Exploits*. Le TLS par défaut de NPM (TLS 1.2 + 1.3, suites ECDHE/AEAD) convient.
- **DNS** (zone `example.com`) : enregistrement **CAA** `0 issue "letsencrypt.org"` (+ `0 iodef "mailto:…"`) pour que
  seule Let's Encrypt puisse émettre un certificat.
- **Box Internet / routeur** : rediriger le **443** vers NPM, jamais le 8790 du CT ; dans le CT, `ALLOW_FROM='10.0.0.10'` limite
  le port 8790 à NPM. Le badge « HTTP to HTTPS redirect » de WebGuardian (hors points) n'est vert que si le **80** est
  aussi redirigé vers NPM (qui n'y sert qu'une redirection 301 et le défi Let's Encrypt) : facultatif.
- `SECURITY_CONTACT='mailto:…'` publie `/.well-known/security.txt` ; `ALLOW_ANON_CREATE='false'` + code de création si
  le serveur ne doit pas être ouvert à tous.
- Liste de préchargement HSTS (hstspreload.org) : seulement pour le domaine racine `example.com` et **si tous ses
  sous-domaines sont en HTTPS** ; inutile pour la note.

### Bascule depuis Camus (image Docker Hub)

ChatSysVisio **n'utilise pas Docker** : installation native (Node.js des dépôts Debian + systemd) dans un CT LXC non
privilégié, sans *nesting*. Camus peut continuer à tourner pendant l'installation ; pour basculer :

1. installer ChatSysVisio dans son CT (section 2) et vérifier `curl -s http://10.0.0.20:8790/healthz` **depuis la machine NPM** ;
2. dans NPM, modifier l'hôte `chat.example.com` (Forward Hostname/IP, Forward Port, Websockets, onglet Advanced comme ci-dessus) ;
3. tester un appel, puis arrêter l'ancien conteneur (`docker stop <conteneur camus>` et `docker update --restart=no <conteneur camus>` sur l'hôte Docker).
   Retour arrière : remettre l'ancienne IP/port dans NPM et redémarrer le conteneur.

Il n'y a rien à migrer : Camus ne conserve ni comptes ni historique.

## 4. Mise à jour

```bash
tar -xzf chatsysvisio-mise-a-jour-1.7.0-b3.tar.gz   # nom exact de l'archive (ou chatsysvisio-mise-a-jour.tar.gz)
cd chatsysvisio-maj
bash update.sh
```

Version et build installés puis nouveaux sont affichés au début (`curl -s http://127.0.0.1:8790/healthz` les donne aussi en local).
Sauvegarde complète dans `/var/backups/chatsysvisio/chatsysvisio-maj-DATE.tar.gz` (5 dernières gardées). L'ancien code est
gardé dans `/opt/chatsysvisio.prev`. Si la nouvelle version ne démarre pas, l'ancienne est remise en place automatiquement.
La configuration existante est conservée (seules les nouvelles clés sont ajoutées : en 1.2, `ADMIN_PATH`, `ADMIN_ALLOW_CIDR`,
`ADMIN_ALLOW_HTTP`, `SIGNUP_MODE`, `ACCOUNTS_ONLY_CREATE`, `GUEST_JOIN`). S'il n'existe encore aucun administrateur, la mise à
jour propose de le créer. La date et les versions de la mise à jour sont notées pour la page Système de l'administration. Le contrôle de sécurité (local +
WebGuardian) est relancé à la fin ; `SECURITY_SCAN=0 bash update.sh` pour sauter la partie publique.

### Passage en 1.3 (chiffrement de bout en bout)

- **Rien à faire dans NPM** ni dans la configuration : même port, mêmes en-têtes, même CSP. Le fragment `#k=` des liens
  n'est jamais envoyé au serveur ni à NPM (il n'apparaît pas dans leurs journaux).
- **Salons existants** : ils continuent de fonctionner, en TLS seulement (le serveur connaît déjà leur contenu, on ne
  peut pas les convertir). L'interface l'indique ; crée un nouveau salon privé pour le bout en bout.
- **Nouveaux salons privés** (avec ou sans mot de passe) : chiffrés de bout en bout par défaut. Partage **le lien
  complet** (bouton « Copier le lien » ou QR) : sans la partie `#k=…`, on voit « Lien incomplet ».
- **Salons publics** : pas de chiffrement de bout en bout (c'est affiché), le résumé Olla y reste possible.
- Vérifier le code servi : `node scripts/code-hash.mjs /opt/chatsysvisio/public` doit donner l'empreinte affichée dans le
  cadenas d'un salon (et celle de l'archive d'origine).

### Passage en 1.3.1 (correctif « pas de son » après la mise à jour)

- **Cause** : un navigateur resté sur l'ancien code (onglet ouvert pendant la mise à jour, ou fichiers en cache) parlait
  au nouveau serveur. Dans un salon chiffré de bout en bout, son son et ses images partaient en clair et les autres ne
  pouvaient pas les lire (et inversement) : appel sans son. Ctrl+F5 corrigeait.
- **Désormais** : chaque page porte le numéro de build et charge des scripts versionnés (`?v=<build>`) ; une page d'une
  autre version se recharge seule (« Nouvelle version, rechargement… ») avant de rejoindre, y compris quand le serveur
  est mis à jour pendant un appel (il suffit ensuite de recliquer sur « Rejoindre »). Un ancien client (1.2 ou 1.3.0)
  est refusé dans un salon chiffré avec un message clair (« recharge la page avec Ctrl+F5 ») au lieu d'un silence.
- **À faire une seule fois après cette mise à jour** : les onglets encore ouverts sur la 1.3.0 ne savent pas se
  recharger seuls ; recharger la page (Ctrl+F5, ou Cmd+Maj+R sur Mac ; sur mobile, fermer puis rouvrir l'onglet).
  Inutile de vider le cache ou le service worker : il est remplacé automatiquement. Garder « Cache Assets » désactivé
  dans NPM (rien à changer si c'est déjà le cas).
- Diagnostic : menu « … » → « Infos techniques » (versions, état du son, paquets audio envoyés / reçus / décodés,
  déchiffrés / rejetés). Rien n'est envoyé.

## 5. Exploitation

| Action | Commande |
|---|---|
| État / journal | `systemctl status chatsysvisio` · `journalctl -u chatsysvisio -f` |
| Redémarrer après modification de la config | `systemctl restart chatsysvisio` |
| Sauvegarde manuelle | `systemctl start chatsysvisio-backup` (archives dans `/var/backups/chatsysvisio`, 14 jours) |
| Restaurer | `systemctl stop chatsysvisio && tar -C / -xzf /var/backups/chatsysvisio/<archive> && systemctl start chatsysvisio` |
| Contrôle de sécurité | `bash /opt/chatsysvisio/deploy/security-scan.sh` |
| Administrateur | `chatsysvisio-admin create-admin` · `list` · `reset-password` · `reset-totp` · `unlock` · `delete` (`--user NOM`, défaut `admin`) |
| Désinstaller | `systemctl disable --now chatsysvisio chatsysvisio-backup.timer chatsysvisio-backup.path chatsysvisio-status.timer chatsysvisio-status.path && rm -rf /opt/chatsysvisio /etc/systemd/system/chatsysvisio* /etc/apt/apt.conf.d/99chatsysvisio /usr/local/sbin/chatsysvisio-*` (données : `/var/lib/chatsysvisio`) |

Données conservées : salons (30 jours sans activité), historique du chat (300 derniers messages par salon), fichiers
partagés (supprimés avec le salon). Aucune vidéo ni aucun son n'est enregistré.

## 6. Options (`/etc/chatsysvisio/chatsysvisio.env`)

| Clé | Rôle |
|---|---|
| `MAX_PARTICIPANTS` | plafond par salon (25 maximum) |
| `VIDEO_LO_KBPS` / `VIDEO_HI_KBPS` / `SCREEN_KBPS` | débits des vignettes / image 360p / partage d'écran 720p |
| `VIDEO_720_KBPS` / `VIDEO_1080_KBPS` / `SCREEN_HD_KBPS` | débits HD 720p (1200) / 1080p (2500) / partage d'écran 1080p (1500) |
| `VIDEO_MAX_HEIGHT` | qualité maximale acceptée par le serveur : `360`, `720` ou `1080` (défaut) — `720` si la liaison montante est < 50 Mbit/s |
| `MEDIA_MAX_KBPS` | débit média maximal reçu d'une personne (défaut 20000 kbit/s) |
| `AUDIO_TOP_N` | nombre de voix relayées simultanément (les plus fortes) |
| `UPLOAD_MAX_MB` | taille maximale d'un fichier partagé (garder `client_max_body_size` de NPM au-dessus) |
| `ROOM_QUOTA_MB` | espace disque maximal des fichiers partagés d'un salon (défaut 200) |
| `MAX_ROOMS` | nombre maximal de salons sur le serveur (défaut 5000) |
| `CREATE_PER_10MIN` | salons créables par adresse IP et par 10 minutes (défaut 10) |
| `ALLOW_FROM` | IP autorisées à joindre le port (vide = toutes) |
| `ALLOW_ANON_CREATE` / `CREATE_PASSWORD_HASH` | voir ci-dessous |
| `AI_ENABLED` / `OLLA_URL` / `OLLA_MODEL` | résumé du chat par Olla (`http://10.0.0.50:11434`), désactivé par défaut |
| `SECURITY_CONTACT` | publie `/.well-known/security.txt` (ex. `mailto:…`) |
| `ADMIN_PATH` | chemin de la page d'administration (défaut `/admin` ; un seul segment, ex. `/gestion-7f3`) |
| `ADMIN_ALLOW_CIDR` | réseaux autorisés à voir l'administration (défaut : boucle locale et réseaux privés). Les autres reçoivent un 404 ordinaire |
| `ADMIN_ALLOW_HTTP` | `false` (défaut) : administration seulement en HTTPS (via NPM) ou depuis la machine elle-même (tunnel SSH) |
| `ADMIN_ENABLED` | `false` pour couper complètement l'administration |
| `SIGNUP_MODE` | inscriptions : `closed` (défaut), `open`, `invite` (code d'invitation) ou `approval` (validation par l'admin) |
| `ACCOUNTS_ONLY_CREATE` | `true` : seuls les comptes créent des salons |
| `E2EE_LABEL` | préfixe des étiquettes E2EE (vide = celui de ChatSysVisio) ; posé par la migration depuis un ancien nom pour garder les salons chiffrés existants |
| `GUEST_JOIN` | `false` : il faut un compte même pour rejoindre par lien |

Les réglages modifiés dans l'administration (création anonyme et code, `CREATE_PER_10MIN`, limite par salon, quotas,
`MAX_ROOMS`, mode d'inscription…) s'appliquent **à chaud** et sont enregistrés dans `/var/lib/chatsysvisio/settings.json`
(0600), qui a priorité sur le fichier `.env` — celui-ci n'est jamais réécrit par le serveur. Supprimer `settings.json`
puis redémarrer revient aux valeurs du `.env`.

**Création de salons** : par défaut, n'importe qui peut créer un salon sans compte (comme Camus). Pour la restreindre à
ceux qui connaissent un code : dans l'administration (Réglages → Code de création), ou `ALLOW_ANON_CREATE='false'` et
`CREATE_PASSWORD_HASH` = résultat de `printf '%s' 'votre code' | node /opt/chatsysvisio/scripts/hash-password.mjs`.

## 7. Administration (1.2)

### Créer l'administrateur

```bash
chatsysvisio-admin create-admin            # en root sur le CT ; --user NOM pour un autre identifiant
```

Le script demande un mot de passe (12 caractères minimum, saisie masquée, jamais affiché ni journalisé), puis affiche
**dans le terminal uniquement** un QR code (généré localement) à scanner avec une application TOTP (Aegis, 2FAS, Google
Authenticator, 1Password…), la clé en texte et **10 codes de secours** à usage unique — à noter hors ligne. Il demande
ensuite un premier code pour vérifier. Le compte est stocké haché (scrypt) dans `/var/lib/chatsysvisio/admin.json` (0600).
Perte du téléphone : un code de secours, ou `chatsysvisio-admin reset-totp`. Compte verrouillé : `chatsysvisio-admin unlock`.

### Accès

`https://chat.example.com/admin/` (ou `ADMIN_PATH`) **depuis le réseau local seulement** : l'adresse réelle du
client est comparée à `ADMIN_ALLOW_CIDR` (X-Forwarded-For n'est cru que s'il vient de NPM, `TRUSTED_PROXIES`). Toute autre
origine reçoit le même 404 qu'une page inexistante (refus noté dans le journal).

- Connexion : identifiant + mot de passe + code à 6 chiffres (ou code de secours). 5 échecs → 15 min de blocage (par IP et
  par compte), 10 essais / 5 min par IP.
- Session courte : cookie `__Host-csv_admin` (Secure, HttpOnly, SameSite=Strict), 15 min d'inactivité, 2 h maximum,
  identifiant renouvelé toutes les 10 min. Chaque action passe un jeton CSRF et est notée dans le journal.
- Sans NPM (tunnel SSH) : `ssh -L 8790:127.0.0.1:8790 root@ct` puis `http://127.0.0.1:8790/admin/` (HTTP autorisé
  seulement en boucle locale).

### Conseils NPM (à faire vous-même dans NPM — l'installation n'y touche pas)

L'administration se protège déjà seule, mais deux verrous supplémentaires sont possibles côté NPM :

1. **Ne pas l'exposer du tout** (le plus sûr) : Proxy Host → onglet *Advanced* → ajouter
   `location ^~ /admin { deny all; }` (adapter si `ADMIN_PATH` a changé). L'administration reste joignable en LAN direct
   ou par tunnel SSH.
2. **Ou une Access List** : *Access Lists* → *Add* → onglet *Access* : `allow 10.0.0.0/24` puis `deny all`, et
   l'appliquer via une *Custom Location* `/admin` du Proxy Host (mêmes réglages que `/`, Websockets inutile).

Un `ADMIN_PATH` non devinable (ex. `/gestion-7f3a`) évite en plus le bruit des robots.

### Ce qu'on y trouve

- **Vue d'ensemble** : débit entrant / sortant, CPU, RAM, disque, salons et participants (courbes SVG sur 1 h), uptime,
  version et build.
- **Salons** : salons en cours et participants (IP partiellement masquées, qualité vidéo, couches), **exclure** quelqu'un
  (avec bannissement temporaire facultatif du salon : IP + session + compte), **fermer** ou **supprimer** un salon.
- **Réglages** (à chaud) : création anonyme et code, `CREATE_PER_10MIN`, limite par salon (≤ 25), `ROOM_QUOTA_MB`,
  `UPLOAD_MAX_MB`, `MAX_ROOMS`, mode d'inscription, création réservée aux comptes, invités autorisés.
- **Comptes** : valider, désactiver, réactiver, supprimer, réinitialiser le mot de passe (mot de passe temporaire affiché
  une seule fois) ; codes d'invitation (affichés une seule fois, stockés hachés).
- **Journal** : connexions, blocages (429, IP refusées), refus d'accès admin, échecs d'authentification, actions admin ;
  filtre ; rotation à 1 Mo × 5 fichiers (`/var/lib/chatsysvisio/logs`). Aucun mot de passe, code ou jeton n'y figure.
- **Système** : sauvegarde immédiate, liste des sauvegardes, version installée, mises à jour Debian en attente (dont
  sécurité), état d'unattended-upgrades, date de la dernière mise à jour de ChatSysVisio.

### Comptes utilisateurs (facultatifs)

Page **Compte** (`/compte`) : inscription avec pseudo + mot de passe (10 caractères minimum, scrypt) selon `SIGNUP_MODE`.
Un compte **réserve son pseudo** dans tous les salons (un invité ne peut pas le prendre ; les réactions sont attribuées
à la personne et non plus au pseudo). Les invités rejoignent toujours par lien, sauf `GUEST_JOIN=false`. Les comptes
(`accounts.json`, 0600, écriture atomique) sont inclus dans les sauvegardes.
