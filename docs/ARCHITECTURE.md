# ChatSysVisio — architecture et choix du transport

## Contrainte

Seul le **TCP 443** est ouvert sur Internet, via un *proxy host* HTTP/HTTPS de Nginx Proxy Manager (NPM) avec WebSockets.
Pas d'UDP, pas d'autre port, pas de TURN ailleurs.

## Options évaluées

| Option | Verdict |
|---|---|
| **WebRTC pair-à-pair (Camus d'origine)** | ✘ ICE/SRTP utilisent l'UDP (ou un TURN). Derrière 443 seul, la plupart des appels échouent hors du LAN. |
| **WebRTC + TURN over TLS sur 443** | ✘ Un TURN parle TLS brut, pas HTTP. NPM (proxy HTTP) ne peut pas le relayer ; il faudrait un *stream* TCP ou un démultiplexeur SNI, donc toucher à NPM. Exclu. |
| **WebRTC SFU en ICE-TCP (mediasoup, LiveKit…)** | ✘ ICE-TCP n'est pas du HTTP non plus : même problème que TURN. |
| **WebTransport (HTTP/3)** | ✘ QUIC = UDP. Absent sur iOS de toute façon. |
| **Média sur WebSocket + WebCodecs** | ✔ **Retenu.** Un seul WebSocket `wss://chat…/ws/<salon>` par personne, relayé tel quel par NPM. |
| **Média sur WebSocket + MediaRecorder (WebM/MP4)** | Repli envisagé puis écarté : latence de plusieurs centaines de ms, segments inutilisables sur Safari pour du direct, pas d'images clés à la demande. |

## Ce qui a été construit

```
navigateur ──(WSS, 443)── NPM ──(WS, 8790)── serveur Node (SFU « sélectif »)
```

- **Capture** : `getUserMedia` → `<video>` → canvas (effets d'arrière-plan éventuels) → `VideoFrame`.
- **Couleurs (1.5.1)** : VP8 ne transporte pas son espace colorimétrique. Chrome encode un canvas RGB en YUV **plage pleine
  BT.709**, une caméra garde le sien (souvent plage pleine BT.601) ; le décodeur, sans indication, supposait BT.709 plage
  limitée → noirs bouchés (16→0), blancs et peaux brûlés (191→204), teintes décalées. L'émetteur lit l'espace réel dans
  `metadata.decoderConfig.colorSpace` et le recopie dans les bits 1-3 du champ `flags` (F_FULL, F_BT601, F_CS) ; le
  récepteur configure `VideoDecoder` avec ce `colorSpace` (reconfiguration à l'image clé) et, si le navigateur l'ignore
  (Safari), ré-étiquette l'image (copie I420). Anciens clients : bits à 0 → comportement d'avant. Limite connue : Firefox
  ignore l'espace des VideoFrame au dessin (écart VP8 restant). H.264 (VUI) et JPEG étaient déjà justes.
- **Vidéo** : WebCodecs **VP8** (H.264 Baseline si VP8 manque ; H.264 en premier sur Safari/iPhone, encodeur matériel),
  jusqu'à trois couches caméra émises **seulement si quelqu'un les regarde** :
  vignette 256×144 à 8 i/s (~70 kbit/s), image moyenne 640×360 à 15 i/s (~450 kbit/s) et, depuis la 1.1, couche **HD**
  1280×720 à 24 i/s (~1,2 Mbit/s) ou **1920×1080 à 24 i/s (~2,5 Mbit/s)**. Partage d'écran : 1920×1080 à 6 i/s
  (~1,5 Mbit/s), ou 1280×720 (~900 kbit/s) en réglage 360p/720p, en repli JPEG ou pendant une adaptation.
- **Son** : AudioWorklet → WebCodecs **Opus** 48 kHz mono 24 kbit/s par trames de 20 ms. Détection d'activité vocale :
  rien n'est émis après 600 ms de silence.
- **Repli universel** (navigateur sans WebCodecs, ex. iPhone sous iOS < 26 pour le son) : vidéo **JPEG**
  (canvas → `toBlob`, décodage `createImageBitmap`), son **IMA-ADPCM** 16 kHz (~66 kbit/s). Le serveur choisit, émetteur
  par émetteur, un codec que **tous** les destinataires savent décoder.
- **Trame binaire** : en-tête de 12 octets (type, id émetteur, couche, clé, codec, horodatage, niveau sonore, séquence)
  + charge utile. Le serveur ne décode rien : il lit l'en-tête et relaie.

### Serveur : routage sélectif pour 25 personnes

- Chaque client s'abonne aux vignettes **visibles** (pagination : 9 par page sur ordinateur, 4 sur mobile) et choisit
  pour chacune une couche : vignette, 360p ou HD (voir ci-dessous).
- Le serveur demande à chaque émetteur uniquement les couches que quelqu'un regarde (`need`) et une image clé à chaque
  nouvel abonné (`keyreq`, limité à une toutes les 400 ms). Il ne relaie à chacun **que la couche à laquelle il est
  abonné** : la HD d'une personne ne part que vers ceux qui l'affichent en grand.
- **Son : seules les 4 voix les plus fortes** (avec hystérésis) sont relayées à chacun (`AUDIO_TOP_N`).
- **Contre-pression** : si le tampon d'émission vers un destinataire dépasse 768 Ko (vidéo) / 1,5 Mo (son), les images sont
  abandonnées ; au-delà de 8 abandons, ce destinataire descend d'un cran (niveau 1 : HD → 360p et 360p → vignette ;
  niveau 2 : vignettes seulement), puis remonte d'un cran après 15 s sans abandon. Côté client, au-delà de 400 Ko en
  attente, seules les images clés partent ; au-delà de 1 Mo, aucune vidéo.
- **Plafonds par session** : message WebSocket ≤ 2 Mio (`maxPayload`), trame média ≤ 1,5 Mo (une image clé 1080p VP8
  fait 100–400 Ko), débit média entrant ≤ `MEDIA_MAX_KBPS` (20 Mbit/s par défaut, rafale de 3 s, seau à jetons ; au-delà
  la vidéo est abandonnée et une image clé redemandée, le son passe toujours). `VIDEO_MAX_HEIGHT` (360/720/1080) plafonne
  la qualité de tout le serveur.

### HD 720p / 1080p (1.1)

**Réglage « Qualité vidéo »** (salle d'attente, réglages et menu « Plus » pendant l'appel, mémorisé dans `localStorage`) :
Auto · 360p · 720p · 1080p · Éco. *Auto* vise 1080p sur ordinateur et 720p sur mobile.

**Quand la 1080p est-elle vraiment envoyée ?** Toutes les conditions suivantes :

1. réglage *Auto* (ordinateur) ou *1080p* ;
2. `VideoEncoder.isConfigSupported` accepte 1920×1080 à 2,5 Mbit/s pour le codec négocié (sinon 720p, message
   « Encodeur 1080p indisponible ») ; jamais en repli JPEG (plafonné à 360p) ;
3. la caméra livre vraiment ≥ 1026 lignes après `applyConstraints` (une webcam 720p reste en 720p) ;
4. sur mobile avec flou/arrière-plan actif : 720p maximum ;
5. **quelqu'un l'affiche en grand** : tuile épinglée, plein écran, mosaïque de ≤ 4 tuiles, ou orateur mis en avant sur
   ordinateur, **et** la tuile fait plus de 480 pixels physiques de haut (taille CSS × densité d'écran, plafonnée à 2).
   Les vignettes restent en 144p/360p ;
6. ni l'émetteur ni le serveur ne sont en adaptation : l'émetteur redescend 1080p → 720p → 360p si sa socket accumule
   plus de 250 Ko (`bufferedAmount`) ou si son encodeur saute plus de 30 % des images pendant 1 s, et remonte d'un cran
   après 20 s sans alerte. Le destinataire dont le décodeur HD prend du retard renonce à la HD pendant 30 s.

Une seule couche HD par émetteur : tous ceux qui l'affichent en grand reçoivent la même (1080p ou 720p selon l'émetteur).

**Flou / arrière-plan en HD** : le détourage MediaPipe travaille sur une image réduite (≤ 480 px de large) et le masque
est appliqué sur l'image composée à la taille demandée (640, 1280 ou 1920 px). Le détourage coûte ainsi le même prix
qu'en 360p ; seule la composition (2 `drawImage` + filtre de flou) grandit. Garde-fou : au-delà de 45 ms par image, la
composition redescend d'abord à 1280 px, puis le détourage passe à une image sur deux, et au-delà de 90 ms il se coupe.
Sur mobile, flou + 1080p est exclu d'office (720p max) : chauffe et batterie.

### Bande passante — estimations

Débits par couche : vignette 0,07 · 360p 0,45 · **720p 1,2 · 1080p 2,5** · partage d'écran 1,5 (1080p) · voix ~0,026 Mbit/s
(Opus 24 kbit/s + en-têtes, 4 voix relayées au plus) ; + ~5 % d'en-têtes WebSocket/TLS.

**Par personne**

| Situation | Montant (envoi) | Descendant (réception) |
|---|---|---|
| Tête-à-tête 1080p | ~2,6 Mbit/s | ~2,6 Mbit/s |
| Tête-à-tête 720p (mobile en Auto) | ~1,3 Mbit/s | ~1,3 Mbit/s |
| Mosaïque de 4 en 1080p (grand écran) | ~2,6 Mbit/s | ~7,6 Mbit/s (3 × 2,5) |
| Orateur à 25, regardé en grand | ≤ 3 Mbit/s (vignette + 360p + 1080p) | ~0,7 Mbit/s |
| Auditeur à 25 (8 vignettes + orateur 1080p) | ~0,1 Mbit/s | ~3,3 Mbit/s |
| Auditeur à 25 sur mobile (orateur 720p, 3 vignettes) | ~0,1 Mbit/s | ~1,5 Mbit/s |
| + partage d'écran 1080p | +1,5 Mbit/s | +1,5 Mbit/s par spectateur |

**Charge du relais (box internet, sens montant)** — 25 personnes :

| Situation | Total montant du serveur | Entrant |
|---|---|---|
| 1.0 : orateur en 360p | ~28 Mbit/s | ~3 Mbit/s |
| **1.1 : orateur en 1080p, 24 auditeurs sur ordinateur** | **~80 Mbit/s** (24 × ~3,3) | ~5 Mbit/s |
| 1.1 : orateur en 1080p, moitié des auditeurs sur mobile (360p hors plein écran) | ~50 Mbit/s | ~5 Mbit/s |
| 1.1 : réglage serveur `VIDEO_MAX_HEIGHT=720` | ~45 Mbit/s | ~4 Mbit/s |
| 1.1 : tout le monde en Éco | ~10 Mbit/s | ~2 Mbit/s |

Sur une fibre ≥ 100 Mbit/s montants, 25 personnes avec un orateur en 1080p passent. Sur un lien plus faible (VDSL,
4G), la contre-pression fait redescendre automatiquement les destinataires concernés (HD → 360p → vignettes) ;
`VIDEO_MAX_HEIGHT=720` la réduit d'environ 40 %. Le CPU du serveur n'augmente pas : il relaie sans décoder.

## Limites connues (honnêtes)

- **HD sur TCP** : une image clé 1080p (100–400 Ko) prend 0,3–1,3 s sur une liaison montante à 2,5 Mbit/s ; une perte
  de paquet retarde tout le flux. Sur 4G ou Wi-Fi chargé, la 1080p redescend vite en 720p/360p : c'est voulu.
- **Mobile** : Auto = 720p ; 1080p possible en réglage manuel si le navigateur l'accepte, mais chauffe et batterie.
  Un téléphone affiche rarement une tuile de plus de 480 px physiques hors plein écran : il reçoit donc souvent la 360p.
- **iPhone** : Safari encode en H.264 matériel (1080p accepté sur iPhone récent) ; une caméra frontale en mode
  économie ou un iPhone ancien peut ne livrer que 720p — on suit alors la caméra. iOS ne fait pas de partage d'écran.
- **Encodeur logiciel** : sans encodage matériel (VM, vieux PC), le VP8 1080p à 24 i/s ne tient pas toujours ;
  l'adaptation passe alors en 720p au bout d'une seconde (cas des tests automatiques en Chrome sans écran).
- **TCP** : une perte de paquet bloque brièvement le flux (*head-of-line blocking*). La latence est un peu plus élevée
  qu'en WebRTC/UDP (typiquement 150–300 ms bout à bout sur une bonne connexion), et un réseau mobile très dégradé fige
  la vidéo plutôt que de la flouter. Le son reste prioritaire (tampons séparés, seuils plus hauts).
- **Annulation d'écho** : assurée par le navigateur sur la capture micro (`echoCancellation`). Comme le son distant est joué
  par Web Audio et non par un élément WebRTC, son efficacité varie (bonne sur Chrome, plus faible sur certains Safari) :
  le casque reste conseillé pour les groupes.
- **iPhone / iPad** : Safari 16.4+ a WebCodecs vidéo ; l'encodeur **Opus** (AudioEncoder) n'existe qu'à partir
  d'**iOS 26** → avant, le son part en ADPCM (≈ 66 kbit/s au lieu de 24) et **tout le salon** reçoit alors la vidéo de
  cet iPhone dans le format qu'il sait décoder. Pas de partage d'écran sur iOS ni Android (API absente).
  L'écran de l'iPhone doit rester allumé (Wake Lock demandé) : en arrière-plan, iOS coupe la caméra.
- **Chiffrement** : salons privés et à mot de passe chiffrés de bout en bout depuis la 1.3 (voir la section dédiée et ses
  limites) ; salons publics et salons créés avant la 1.3 : TLS jusqu'au serveur seulement, et l'interface le dit.
- Les sessions (cookie) sont en mémoire : un redémarrage du service oblige à recliquer « Rejoindre » (et à ressaisir le
  mot de passe d'un salon protégé). Il en va de même pour les sessions d'administration et les bannissements temporaires
  (un redémarrage les lève).

## Chiffrement de bout en bout (1.3)

### Objectif et modèle de menace

Personne d'autre que les participants — ni le serveur, ni quelqu'un qui contrôle le CT, Nginx Proxy Manager, le
réseau ou les sauvegardes — ne doit pouvoir **lire, voir ou entendre** : vidéo, son, partage d'écran, messages,
réactions, fichiers et historique stocké. On suppose que l'attaquant voit tout ce qui passe par le serveur et tout ce
qui est sur son disque, **mais que le code JavaScript servi aux navigateurs est le bon** (voir « Limites »).

### Le schéma, simplement

1. **La clé du salon naît dans le navigateur** de la personne qui crée le salon (32 octets aléatoires) et voyage
   seulement dans le **fragment** du lien : `https://…/r/famille-k7m2qx#k=…`. Un navigateur n'envoie jamais le
   fragment au serveur (ni à NPM, ni dans les journaux). Le bouton « Copier le lien » et le QR code l'incluent.
2. **Mot de passe facultatif** (salon privé + mot de passe) : il est étiré dans le navigateur (PBKDF2-SHA-256,
   600 000 tours, sel du salon). Le secret du salon = HKDF(lien ‖ mot de passe) : il faut **les deux**.
   Le serveur reçoit seulement un **jeton d'accès** dérivé avec une autre étiquette HKDF (`…/access`), qu'il hache en
   scrypt comme avant : le vérificateur d'accès est séparé de la clé, le serveur ne peut pas en déduire la clé.
   La valeur de contrôle (kcv) qui permet au navigateur de dire « mauvais mot de passe » n'est donnée qu'après l'accès
   (pas d'attaque hors ligne sur le mot de passe à partir de l'API).
3. Du secret, HKDF-SHA-256 dérive des clés indépendantes (étiquettes `chatsysvisio/e2ee/v1/<usage>`) : chat, contrôle
   (kcv), authentification des annonces, première clé média, **code de sécurité**.
4. **Médias** : chaque trame vidéo/son/écran (WebCodecs ou repli JPEG/ADPCM) est chiffrée en **AES-GCM-256** après
   l'encodage. Clé par émetteur = HKDF(clé d'époque, nonce aléatoire de l'émetteur) ; IV = compteur 48 bits jamais
   réutilisé (unique par clé). L'en-tête de 12 octets reste en clair pour le routage (type, couche, image clé,
   codec, horodatage, niveau sonore arrondi) mais il est **authentifié** (AAD) avec l'époque et le compteur : toute
   modification ou rejeu (fenêtre de 2048 trames) est rejeté. Le serveur réécrit seulement l'identifiant d'émetteur.
   Son en Opus à débit constant (CBR) : la taille des paquets ne trahit pas les mots prononcés.
5. **Rotation** : chaque participant annonce une clé publique ECDH P-256 éphémère, authentifiée par HMAC (clé dérivée
   du secret du salon : le serveur ne peut pas glisser sa propre clé). Le « meneur » (plus petit identifiant présent)
   distribue la clé d'époque emballée (ECDH → HKDF → AES-GCM) à chaque arrivant et **en tire une nouvelle à chaque
   départ ou exclusion**, envoyée aux seuls restants : la personne partie ne peut plus déchiffrer les flux suivants.
6. **Chat, réactions, fichiers** : chaque message (texte, nom et type de fichier, clé du fichier, citation) est un
   seul bloc AES-GCM (IV aléatoire de 96 bits, usage en AAD). Les réactions sont chiffrées par personne. Chaque
   fichier a sa propre clé aléatoire (dans le message chiffré) ; le serveur stocke un blob opaque `CCE1…` nommé
   `fichier-chiffre.bin`. Le navigateur le déchiffre en `blob:` et ne l'affiche comme image qu'après avoir vérifié la
   signature (PNG, JPEG, GIF, WebP).
7. **Code de sécurité** (12 chiffres, dérivé du secret) : affiché dans le cadenas, à comparer à voix haute. S'il est
   identique, tout le monde a la même clé (aucun lien trafiqué).

### Selon le type de salon

| Salon | Chiffrement | Ce que voit le serveur | Olla (résumé IA) |
| --- | --- | --- | --- |
| **Privé** (par défaut, option « Bout en bout ») | De bout en bout, clé dans `#k=` | Métadonnées seulement | Désactivé |
| **Privé + mot de passe** | De bout en bout, clé = lien + mot de passe | Métadonnées seulement | Désactivé |
| **Public** | **Pas de bout en bout** : TLS jusqu'au serveur | Tout (comme en 1.2) | Disponible |
| Privé sans l'option, ou créé avant 1.3 | TLS seulement | Tout | Disponible |

Un salon public est par nature ouvert à tous (listé, lien sans clé) : un chiffrement de bout en bout n'y protégerait de
rien. L'interface l'affiche (« Salon public : pas de chiffrement de bout en bout ») à la création et dans le salon.

### Ce qui reste visible (métadonnées)

Noms affichés, heures de connexion et de message, nombre de participants, adresses IP (journal, administration),
tailles et cadence des trames (donc qui parle à peu près quand, qui a la caméra allumée, définition envoyée), taille
des messages et des fichiers, états (micro, caméra, main levée), noms des salons. L'administration voit ces
métadonnées et la mention « bout en bout », jamais le contenu.

### Limites (honnêtes)

- **Le code servi** : la protection repose sur le JavaScript envoyé par ton serveur. Quelqu'un qui contrôle le CT
  pourrait servir une version modifiée qui exfiltre la clé. Le cadenas affiche la version, le build et une
  **empreinte SHA-256 de public/** ; `node scripts/code-hash.mjs public` sur une archive de confiance (ou sur
  `/source.tar.gz` décompressée) donne la même valeur. Un serveur compromis peut mentir sur cette empreinte : c'est un
  indicateur, pas une preuve (même limite que toute messagerie web).
- **Personne exclue** : elle perd la clé des flux (rotation), mais garde le lien, donc peut relire le chat et les
  fichiers si elle revient (l'exclusion serveur l'en empêche, pas la cryptographie). Pour l'écarter vraiment : nouveau
  salon, nouveau lien.
- **Lien = clé** : qui a le lien complet (et le mot de passe s'il y en a un) peut tout déchiffrer. Le lien est gardé
  dans ce navigateur (`localStorage`, pour les « Récents ») ; le secret dérivé d'un mot de passe ne l'est que pour
  l'onglet (`sessionStorage`).
- **Pas de confidentialité persistante pour le chat** : l'historique est chiffré avec une clé fixe du salon (sinon les
  nouveaux venus ne pourraient pas le lire).
- **Métadonnées** visibles (voir ci-dessus). Olla est désactivé dans ces salons.
- **Coût** : environ 0,05 ms par trame sur un PC ; sur téléphone modeste simulé (processeur ×6 plus lent) la charge
  d'un appel à 25 (1 600 trames/s chiffrées ou déchiffrées) tient en ~12 % d'un cœur. Pas de Worker : WebCrypto est
  natif et asynchrone. Surcoût réseau : 23 octets par trame (≈ 1 % en vidéo).
- Salons existants : restent en TLS seulement (la clé ne peut pas être ajoutée a posteriori, le serveur connaît leur
  contenu) ; l'interface le dit et propose d'en créer un nouveau.

## Sécurité

- En-têtes : CSP stricte sans aucune origine externe ni script/style inline ; `'wasm-unsafe-eval'` **uniquement** sur la
  page d'appel et ses scripts (nécessaire au détourage MediaPipe en WebAssembly : autorise la compilation de WASM servi par
  le site, pas `eval()` JavaScript). HSTS 2 ans (derrière HTTPS), X-Frame-Options DENY, nosniff, Referrer-Policy,
  Permissions-Policy (caméra, micro, capture d'écran : `self`), COOP same-origin, COEP require-corp, CORP same-origin.
- Cookie `__Host-csv_sid` Secure, HttpOnly, SameSite=Strict ; jeton CSRF + contrôle d'Origin sur toutes les requêtes POST et
  le WebSocket. Mots de passe de salon hachés (scrypt, salés) ; limitation de débit sur la création, les essais de mot de
  passe (par IP et par salon), l'envoi de fichiers et les connexions WebSocket.
- Salons privés : adresse avec suffixe aléatoire (`/r/famille-k7m2qx`), non listés.
- Fichiers partagés : stockés hors de la racine web, servis seulement aux membres du salon, `attachment` sauf images
  vérifiées (signature), `nosniff` + CSP `sandbox`.
- Plafonds anti-saturation (1.0.1) : 20 000 sessions en mémoire au plus (les sessions sans salon expirent en 24 h et
  partent en premier), 4 connexions WebSocket simultanées par session et par salon, débit borné par type de message de
  contrôle (réactions 5/s, renommage 2/s, états 10/s… et 120/s au total), quota disque de fichiers par salon
  (`ROOM_QUOTA_MB`, 200 Mo) et nombre maximal de salons (`MAX_ROOMS`, 5000). Vérification scrypt asynchrone (la boucle
  d'événements, donc le relais vidéo, n'est jamais bloquée). `/healthz` ne donne la version qu'en local ; méthodes
  autres que GET/HEAD/POST : 405 avec `Allow`.
- Tout est auto-hébergé (polices, MediaPipe, modèle de détourage, générateur de QR) ; aucune requête vers un tiers.

## Administration et comptes (1.2)

Modules : `server/admin.mjs` (accès, session, API), `server/admin-ui/` (interface, **hors** de `public/` : jamais servie
par le routage statique), `server/accounts.mjs` (comptes, invitations, administrateurs), `server/totp.mjs` (RFC 6238),
`server/settings.mjs` (réglages à chaud), `server/events.mjs` (journal), `server/stats.mjs` (mesures),
`scripts/chatsysvisio-admin.mjs` (CLI).

**Filtrage** — avant tout traitement, l'adresse réelle (`clientIp` : X-Forwarded-For seulement si la connexion vient d'un
proxy de confiance, dernière adresse de la chaîne) est comparée à `ADMIN_ALLOW_CIDR` (`net.BlockList`, IPv4/IPv6, adresses
IPv4 mappées comprises). Refus = la même page 404 que n'importe quelle adresse inconnue, aussi pour l'interface et l'API ;
HTTP en clair refusé sauf client en boucle locale. `ADMIN_PATH` est validé au démarrage (un segment, sans collision avec
les routes ou les fichiers publics).

**Authentification** — pas de compte par défaut : création uniquement par la CLI en root (ou proposée par
install/update). Mot de passe ≥ 12 caractères (scrypt), TOTP obligatoire (SHA-1, 30 s, ±1 pas, **anti-rejeu** : un pas
déjà utilisé est refusé), 10 codes de secours stockés en SHA-256 et à usage unique. Vérification à temps constant même
pour un identifiant inconnu (hachage factice). Verrouillage 15 min après 5 échecs par IP ou par compte, plus 10 essais /
5 min par IP. Session séparée de celle des salons (`__Host-csv_admin`, Path=/, SameSite=Strict) : 15 min d'inactivité, 2 h
au plus, identifiant changé à la connexion et toutes les 10 min (30 s de tolérance pour les requêtes en vol). Toutes les
requêtes POST : contrôle d'Origin + `X-CSRF-Token`. Même CSP stricte que le reste (aucun inline : les largeurs des barres
et les courbes passent par le DOM/CSSOM et du SVG construit en JS), `X-Robots-Tag: noindex`, `Cache-Control: no-store`.

**Secrets** — le mot de passe, la clé TOTP et les codes de secours ne sont affichés que dans le terminal de la CLI ; les
codes d'invitation et mots de passe temporaires ne sont affichés qu'une fois dans l'interface et stockés hachés. Le
journal retire toute clé ressemblant à un secret (`password`, `code`, `token`, `csrf`, `cookie`, `hash`, `totp`…), et
les IP y sont masquées (`192.168.1.••`).

**Actions sans privilèges** — le service reste l'utilisateur `chatsysvisio` sans sudo (`NoNewPrivileges`,
`ProtectSystem=strict`). Pour « Sauvegarder maintenant », il dépose un fichier `requests/backup` ; l'unité
`chatsysvisio-backup.path` (systemd, root) lance la sauvegarde, puis `chatsysvisio-status` réécrit `system-status.json`
(sauvegardes, `apt-get -s upgrade`, unattended-upgrades, dernière mise à jour) que le serveur se contente de lire. Même
mécanisme pour « Actualiser » (`chatsysvisio-status.path`), plus un passage horaire (`chatsysvisio-status.timer`).

**Réglages à chaud** — `settings.json` (0600, écriture atomique) surcharge le `.env`, qui n'est jamais réécrit. Valeurs
bornées côté serveur (limite par salon 2–25, etc.) ; les limiteurs de débit sont reconstruits immédiatement.

**Exclusion** — fermeture du WebSocket avec le code 4004 (salon fermé : 4005, l'interface ne tente pas de se reconnecter)
et retrait du salon de la session : revenir impose de repasser par `/join`, où le bannissement (IP, session, compte, en
mémoire, durée choisie) est vérifié, comme à l'ouverture du WebSocket.

**Comptes** — `accounts.json` (0600, atomique, inclus dans les sauvegardes) : pseudo unique (comparaison sans casse ni
accents), scrypt, statut actif / en attente / désactivé, verrouillage 15 min après 8 échecs. La connexion change
l'identifiant de session (anti-fixation). Un pseudo de compte est **réservé** : un invité qui le demande reçoit 409 à
`/join` et une erreur `reserved` dans le salon ; un compte connecté garde son pseudo. Les réactions du chat sont désormais
indexées par personne (`u:<compte>` ou empreinte de session), plus par pseudo — ces clés ne quittent jamais le serveur.
Désactiver ou supprimer un compte le déconnecte de toutes ses sessions.

**Statistiques** — échantillon toutes les 10 s (360 points = 1 h) : octets relayés (entrée/sortie du hub), CPU machine
et processus, mémoire, salons et participants ; disque par `statfs`, taille des données recalculée toutes les 5 min.

## Arrière-plans

MediaPipe Tasks Vision (ImageSegmenter, modèle *selfie_segmenter*, 250 Ko) servi depuis `/vendor/mediapipe/`, GPU puis CPU.
Flou, 4 décors dessinés localement, ou image personnelle (gardée dans le navigateur uniquement). Détourage sur une image
réduite (≤ 480 px), composition à la taille envoyée (jusqu'à 1920×1080, voir « HD »). Garde-fou : au-delà de 45 ms par
image la composition passe à 1280 px puis le détourage à une image sur deux ; au-delà de 90 ms il se coupe avec un
message (téléphones faibles).

## Versions et builds

`VERSION` donne la version, `BUILD` un numéro de build croissant (incrémenté par `scripts/package.sh`, puis commité).
Archives : `chatsysvisio-complet-<version>-b<build>.tar.gz` et `chatsysvisio-mise-a-jour-<version>-b<build>.tar.gz`
(+ copies sans numéro `chatsysvisio-complet.tar.gz` / `chatsysvisio-mise-a-jour.tar.gz`, pointant sur la dernière).
Version et build sont affichés par `install.sh` / `update.sh`, par `/healthz` en accès local et, discrètement, dans
la barre latérale (« v1.2.0 · b4 ») et sur la page Système de l'administration.

### Cohérence client / serveur (1.3.1)

Incident 1.3.0 : après la mise à jour, un navigateur resté sur l'ancien code (onglet ouvert, cache navigateur ou proxy)
rejoignait un salon chiffré de bout en bout sans savoir chiffrer : ses trames partaient en clair, illisibles pour les
autres (et les leurs pour lui) → « pas de son » jusqu'à Ctrl+F5. Correctifs :

- **Versionnement des fichiers** : le serveur ajoute `data-build` à chaque page HTML et `?v=<build>` aux scripts, feuilles
  de style, imports entre modules, worklets et worker (transformation à la volée, en mémoire). ETag dépendant du build ;
  HTML et `sw.js` en `no-cache, no-store`. Le service worker prend le cache `cc-shell-<build>`, s'active aussitôt
  (`skipWaiting` + `clients.claim`), supprime les anciens caches ; il est enregistré avec `updateViaCache: 'none'`.
- **Vérification au chargement et aux reconnexions** : `ensureFresh()` compare `data-build` au build de `/api/session` ;
  s'ils diffèrent, caches vidés et rechargement unique (sinon message « Ctrl+F5 »). Après deux coupures, le client relit
  la session : nouvelle version → rechargement ; session perdue (redémarrage) → rechargement de la page du salon.
- **Protocole** : `hello` porte `proto` (2) et `build`. Salon chiffré sans `proto` ≥ 2 → message `error/version` puis
  fermeture 1008 (un client 1.2 affiche le message) ; build différent → fermeture 4010 et rechargement. Dans un salon
  chiffré, aucun média n'est relayé avant l'annonce de clé de l'émetteur.
- **Encodeur Opus** : `isConfigSupported` testé avec et sans débit constant ; un refus (même asynchrone) passe à la
  configuration suivante puis à l'ADPCM, sans boucle.
- **Tests** : `test/e2e/audio.spec.mjs` mesure le son réellement joué chez l'autre (AnalyserNode en sortie du lecteur), dans
  les deux sens, en salon chiffré et public, micro coupé = silence ; Chromium et Edge, et Chrome ↔ WebKit/Firefox dans
  `navigateurs.spec.mjs`. Panneau « Infos techniques » (menu « … ») avec les compteurs audio.

## Traitement du micro (1.6, autotune 1.8)

- Chaîne Web Audio dans le même `AudioContext` que la capture (`public/js/micfx.js`) :
  `MediaStreamSource → [RNNoise] → [autotune] → [DynamicsCompressor + gain +2 dB] → [dé-esseur] → cc-capture → Opus`.
  Chaque interrupteur recâble les nœuds (`MicChain.set`) : le micro n'est pas rouvert, l'appel continue. Réglages dans
  `localStorage['csv-micfx']` (`{ ns, comp, deess, tune, tuneSpeed, tuneKey, tuneMinor }`, tous coupés par défaut ;
  un ancien réglage à trois clés reste lu).
- **Réduction de bruit** : RNNoise (BSD-3-Clause) compilé en wasm par `@shiguredo/rnnoise-wasm` (Apache-2.0), worklet
  de `@sapphi-red/web-noise-suppressor` (MIT), copiés par `scripts/vendor.mjs` dans `public/vendor/rnnoise/` avec leurs
  licences (`docs/licences/`). Version SIMD si le navigateur la valide, sinon version simple. Le binaire est téléchargé
  par la page puis transmis au worklet (`processorOptions`). Latence ajoutée ≈ 27 ms. Aucun changement de CSP :
  `'wasm-unsafe-eval'` était déjà présent sur la seule page d'appel (MediaPipe) ; l'accueil et les autres pages restent sans.
- **Dé-esseur** (`public/js/dsp.js`, worklet `cc-deesser`) : passe-bande 5–9 kHz en détection latérale ;
  `y = x − (1 − g)·bande(x)`, g calculé sur l'enveloppe de la bande (seuil −34 dBFS et niveau global − 9 dB, ratio 4:1,
  jusqu'à −14 dB, attaque 1 ms, relâchement 70 ms). Hors sifflante g = 1 : sortie identique à l'entrée.
- **Autotune** (`public/js/autotune.js`, worklet `cc-autotune` chargé à la demande, `import` de module, sans CDN).
  Le code est original, à partir des publications ; les brevets PSOLA et Antares ont expiré (voir `NOTICE.md`).
  - *Détection* : YIN sur le signal décimé vers ≈ 12 kHz (filtre de Butterworth d'ordre 4), fenêtre de 16 ms toutes
    les 5 ms ; seuil 0,15. Le son est jugé non voisé si l'apériodicité dépasse 0,25 ou si le niveau est sous −50 dBFS.
    La période est affinée à pleine cadence (différence carrée, puis interpolation parabolique). Plage 70–1 000 Hz.
  - *Cible* : note de la gamme la plus proche (chromatique, ou majeur / mineur sur une tonique), avec une hystérésis
    de 15 cents. Le rapport est lissé avec τ = 0,14 s·(1 − vitesse/100)², donc 100 = saut instantané (« robot »). Il
    repart de zéro à chaque attaque qui suit plus de 60 ms de silence.
  - *Transposition à durée constante* : deux têtes de lecture dans une ligne à retard, aux retards L + (p − ½)·D,
    pondérées en sin² et en quadrature. p avance de (1 − r)/D. La fenêtre D est un multiple de la période (≈ 16 ms,
    avec hystérésis) : c'est un PSOLA synchrone, sans battement. Lecture par interpolation d'Hermite.
  - *Latence fixe* L = 13 ms (624 échantillons à 48 kHz). Hors voix, la sortie vaut exactement x[n − L] : la
    différence avec le signal retardé est nulle, ce qui garantit l'absence d'artefact. Passage voisé ↔ non voisé
    en fondu de 6 ms.
  - *Ordre dans la chaîne* : après la réduction de bruit, pour détecter sur une voix propre ; avant le compresseur,
    pour que ses variations de gain ne faussent pas YIN, le compresseur égalisant ensuite le chant corrigé. Le
    dé-esseur reste en dernier.
  - Le worklet poste `{ voiced, hz, note, target, cents }` environ 10 fois par seconde, pour l'affichage en direct.
  - Sans AudioWorklet, ou si le module est refusé : état « indisponible », le son passe sans correction.
- Tests :
  - `test/unit/micfx.test.mjs` et `test/unit/autotune.test.mjs` (DSP : 450 → 440 Hz, gammes, durée, bruit intact,
    voix de synthèse `scripts/voix-synthese.mjs`, CPU) ;
  - `test/e2e/micfx.spec.mjs` : mesure du signal par rendu hors ligne dans la page d'appel, interrupteurs,
    application à chaud, note en direct avec un micro factice « chanteur », replis ;
  - `navigateurs.spec.mjs` : la même mesure dans Firefox et WebKit.
- Coût : `scripts/micfx-bench.mjs`.

## « Vu » et tableau blanc (1.7)

- **Accusés de lecture** : chaque message utilisateur garde côté serveur la clé d'identité de son auteur (`ark` =
  `p.rk`, compte ou empreinte de session ; jamais diffusée, retirée par `publicMsg`). Le client envoie
  `{t:'seen', ids:[…]}` (50 ids au plus, regroupés toutes les 800 ms, 4 envois/s) seulement si l'onglet est visible,
  le panneau Messages ouvert et le message affiché à 60 % (IntersectionObserver sur `#msgs`). Le serveur ignore les ids
  inconnus, les messages système/IA et ses propres messages ; le lecteur est toujours la connexion émettrice. Agrégat en
  mémoire dans l'état du salon (`rs.seen` : 400 messages × 30 lecteurs au plus, le plus ancien sort en premier), libéré
  quand le salon se vide. Seules les connexions de l'auteur reçoivent `{t:'seen', items:[{id, by:[noms]}]}` ; à la
  reconnexion, l'historique porte `own:true` sur ses messages et les accusés sont renvoyés. Salon chiffré : l'accusé ne
  porte que l'id opaque du message ; le nom du lecteur est déjà connu du serveur (liste des participants), le chiffrer
  n'apporterait rien et empêcherait la validation.
- **Tableau blanc** (`public/js/board-model.js` partagé serveur/navigateur, `public/js/board.js` pour la vue) : feuille
  16:9 en coordonnées entières 10000 × 5625, traits `{id, k, c, w, pr?, p:[x,y(,pression)…]}` (400 points au plus ; un
  trait plus long est découpé et annulé d'un bloc), formes à 2 points. Pointer Events (`getCoalescedEvents`, capture,
  `touch-action:none`), lissage quadratique, gomme `destination-out`, rendu sur deux canvas (base + direct). Fragments en
  direct (`op:'live'`, toutes les 50 ms) relayés sans être stockés ; traits finis (`op:'add'`) conservés dans
  `rs.board.items` et rejoués aux arrivants (`op:'state'` après `welcome`). `undo` ne retire que les traits dont l'auteur
  (`rk`) est l'émetteur ; `redo` renvoie les traits sous de nouveaux ids. `open` (un seul tableau), `lock`, `clear`,
  `close` : ouvreur seulement. Limites : 5000 traits, 4 Mo, 12 000 caractères par trait chiffré, débits par personne
  (direct 40/s, ajout 20/s, annulation 10/s, gestion 3/s), plus les plafonds généraux (20 000 caractères, 120 messages/s).
  Départ de l'ouvreur : 20 s de grâce (même `rk` → reprise), sinon fermeture. Salon chiffré : traits scellés avec la clé
  du salon (AES-GCM), étiquette `wb:<id>` pour les traits conservés (l'id est lié au contenu) et `wbl` pour le direct ;
  le serveur ne voit que `{id, enc}`. Affichage : tuile `wb` placée en grande vue avant les écrans partagés, `S.pinned`
  prioritaire. Aucun changement de CSP (pas de script en ligne, pas de CDN).

## Interface et système visuel (1.4, mise en page 1.5)

Inspirée d'Emil Kowalski (emilkowal.ski, Sonner, Vaul) et des règles du skill « impeccable » (mode « operate » :
précision et retenue pour une application). Tout tient dans `public/css/app.css` (+ `server/admin-ui/admin.css`) :

- **Jetons** (1.4.1, « bleu calme », esprit Apple / Linear) : neutres froids teintés ardoise, fond sombre anthracite
  bleuté (`#16181d`, pas de noir pur), un seul accent bleu : `--acc` (texte/liens, AA), `--acc-solid` (boutons
  principaux, texte blanc AA), `--ring` (focus, personne qui parle — anneau net de 2 px sans halo —, curseur,
  courbes de l'admin) ; états sémantiques `--ok/--warn/--bad`. Bordures en ombre d'un pixel (`--sh-*`), ombres
  décalées et douces. Icônes PWA et favicon : carré bleu, caméra blanche (`scripts/make-icons.mjs`).
- **Thème** : sans choix enregistré, `prefers-color-scheme` décide (CSS seul, pas de flash) ; le bouton pose `.light`
  ou `.dark`. `theme-color` : deux balises `media`, mises à jour par `applyTheme()`.
- **Typographie** : Inter auto-hébergée (OFL), `cv01`/`ss03`, repli Arial aux métriques ajustées (pas de saut au
  chargement), chiffres tabulaires pour les durées, débits et compteurs, 16 px dans les champs sur mobile (pas de zoom iOS).
- **Mouvement** : `--ease-out: cubic-bezier(.23,1,.32,1)`, 120–200 ms pour les contrôles, entrées en `@starting-style`
  (CSS seul, interruptibles), sorties plus courtes ; jamais depuis `scale(0)` ; menus nés de leur bouton
  (`--origin`) ; enfoncement à 0,97 ; aucune animation sur l'envoi d'un message au clavier. Notifications à la Sonner
  (400 ms `ease`, minuterie en pause onglet masqué ou au survol). Sur mobile, modales et panneau en tiroir du bas
  (courbe iOS de Vaul `cubic-bezier(.32,.72,0,1)`), fermeture par glissement (quart de hauteur ou geste rapide).
- **Accessibilité** : focus visible partout (anneau bleu), survols limités à `(hover:hover) and (pointer:fine)`,
  `prefers-reduced-motion` : on garde les fondus, on retire déplacements, échelles et égaliseurs.
- **Mise en page 1.5** (couleurs inchangées) :
  - accueil éditorial (`body.homepage`, sans barre latérale) : grand titre, composeur avec bouton texte
    « Créer » / « Rejoindre », colonne « Rejoindre » et récents en liste à filets ; sur mobile le composeur reste
    à portée du pouce, au-dessus de la barre d'onglets ;
  - appel (`body.incall`) : barre latérale repliée par défaut (`#sideBtn`, mémorisé dans `cc-side`), scène sombre
    dans les deux thèmes (jetons sombres locaux), tuiles à 18 px espacées, noms sur un dégradé de lisibilité,
    en-tête et dock posés sur la vidéo, effacés après 3,5 s sans activité (`body.idle`, jamais sur mobile, ni avec un
    menu, une modale ou un focus clavier dans les commandes) ;
  - dock en pilule de verre dépoli, boutons ronds, info-bulles CSS (`data-tip`) : première après 450 ms, suivantes
    immédiates (`.dock.warm`) ;
  - disposition grille / orateur (`#viewSeg`, mémorisée dans `cc-view`, grille par défaut) : en mode orateur, la
    personne qui parle en grand, les autres en bande dessous (même logique que l'épinglage et le partage d'écran) ;
  - discussion en carte flottante, bulles regroupées par auteur (moins de 5 min, classe `cont`), les siennes à
    droite en bleu ; sur mobile, tiroir du bas à 88 % avec poignée et fermeture par glissement (`dragToClose`) ;
  - admin : navigation plus lisible, titres de page affirmés, chiffres clés et graphiques plus aérés.
- **CSP** : aucune règle inline ; les rares valeurs dynamiques passent par le CSSOM (`el.style…`), autorisé par la CSP.
