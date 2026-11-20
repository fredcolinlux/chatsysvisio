# ChatSysVisio

*[English](README.md) · Français*

![Appel](docs/img/appel-bureau.png)

Visio et messagerie auto-hébergées, en français, pour 25 personnes par salon — **uniquement via HTTPS 443**.
Dérivé de [Camus](https://github.com/camuschat/camus) (AGPL-3.0, voir `NOTICE.md`).

- Salons publics ou privés, mot de passe, limite de participants, page des salons publics.
- **Chiffrement de bout en bout** (1.3) des salons privés et à mot de passe : vidéo, son, écran, chat, réactions,
  fichiers et historique illisibles pour le serveur ; clé dans le lien (`#k=…`), code de sécurité à comparer.
  Les salons publics ne sont **pas** chiffrés de bout en bout (TLS jusqu'au serveur) et l'affichent.
- Vidéo jusqu'en **1080p** (réglage Auto / 360p / 720p / 1080p / Éco, HD envoyée seulement à qui l'affiche en grand,
  adaptation automatique), mosaïque paginée, orateur mis en avant, son, partage d'écran 1080p, plein écran, image dans l'image.
- Chat : réponses, Markdown, réactions, fichiers et images, « … écrit », présence.
- Salle d'attente : aperçu caméra, niveau du micro, choix des périphériques, flou / arrière-plans.
- Main levée, réactions, invitation par lien ou QR code local, appli installable (PWA), thème sombre / clair.
- **Administration** (1.2, réseau local seulement, mot de passe + TOTP) : statistiques, salons et participants
  (exclure, bannir, fermer), réglages à chaud, comptes et invitations, journal, sauvegardes et mises à jour système.
- **Interface 1.4** (bleu calme depuis 1.4.1) : neutres froids teintés ardoise, un seul accent bleu réservé à l'action
  principale et à l'état (parole, sélection, focus), thème qui suit
  le système (sombre / clair), mouvements courts en ease-out, tiroirs du bas sur mobile, mouvement réduit respecté.
- **Mise en page 1.5** : accueil éditorial, appel immersif (scène sombre, dock flottant en verre dépoli, en-tête qui
  s'efface au repos, mode orateur en plus de la grille), discussion en bulles regroupées, admin plus aérée.
- **Couleurs fidèles (1.5.1)** : l'émetteur annonce l'espace colorimétrique réel de son flux VP8 (plage pleine/limitée,
  BT.601/709), le récepteur décode en conséquence ; voile sous les noms allégé. Mesuré par une mire (`scripts/color-measure.mjs`,
  test `couleurs.spec.mjs`) : ΔE moyen 3,1 → 0,3.
- **Traitement du micro (1.6)** : réduction de bruit (RNNoise en WebAssembly, calculée sur l'appareil), compresseur et
  dé-esseur, interrupteurs indépendants appliqués à chaud pendant l'appel (salle d'attente ou menu « … »).
- **Autotune (1.8)** : ramène le chant sur la note juste (chromatique ou gamme majeure / mineure), vitesse réglable de
  naturelle à « robot », note affichée en direct ; calculé sur l'appareil, 13 ms de latence, son intact hors voix chantée.
- **Réglages de la caméra (1.10)** : luminosité, contraste, saturation, netteté, exposition et balance des blancs quand
  le navigateur les expose (Chrome / Edge sur ordinateur), mode faible lumière (15 i/s, exposition plus longue, bien
  moins de grain) et choix du débit HD ; 1080p à 4 Mbit/s en petit salon, image clé HD toutes les 10 s au lieu de 4.
- **Salons publics éphémères (1.12)** : un salon public sans mot de passe est supprimé (historique, fichiers, nom
  libéré) 10 minutes après le départ du dernier participant, délai réglable (`PUBLIC_ROOM_IDLE_TTL_MIN`) et conservé
  au redémarrage ; les salons privés gardent l'expiration après 30 jours d'inactivité.
- **Rehaussement faible lumière (1.11)**, désactivé par défaut : éclaircit les ombres et le visage sans brûler les LED
  et lisse le grain (débruitage bilatéral + temporel avec détection de mouvement, balance des blancs auto limitée en
  option, intensité réglable), sur la carte graphique (WebGL2), avant l'envoi, combiné au flou ; coût mesuré par image,
  repli automatique (filtre allégé → 720p → arrêt). Aperçu de soi en **champ complet** (il était rogné par
  `object-fit: cover`), **miroir** par défaut (option), **zoom** de la caméra quand elle le permet.
- **Isolateur de voix (1.9)** : garde ta voix et retire musique, télé, bruits et la plupart des voix derrière toi pendant
  tes pauses (modèle DeepFilterNet3 exécuté sur l'appareil, WebAssembly, ≈ 11 Mo téléchargés une seule fois depuis ton
  serveur, seulement s'il est activé) ; intensité réglable, ≈ 39 ms de latence, réduction de bruit incluse. Il ne sait pas
  *qui* parle : une voix aussi forte que la tienne passe pendant que tu parles.
- **Tableau blanc partagé (1.7)** : croquis à plusieurs, affiché chez tous comme un partage d'écran ; stylet sensible à la
  pression, formes, gomme, annulation par personne, export PNG, verrou par la personne qui l'a ouvert ; traits vectoriels,
  chiffrés de bout en bout dans les salons privés.
- **« Vu » dans le chat (1.7)** : « Vu par … » sous ses propres messages, seulement quand le message a vraiment été affiché.
- **Comptes facultatifs** : pseudo réservé, inscriptions fermées / ouvertes / sur invitation / validées par l'admin.

**Installation rapide (paquet autonome hors ligne, Debian 13)** :

```bash
sha256sum -c chatsysvisio-1.12.0.tar.gz.sha256
tar -xzf chatsysvisio-1.12.0.tar.gz && cd chatsysvisio-1.12.0 && bash install.sh
```

Manuel complet : **`docs/MANUEL.md`** · migration depuis l'ancien nom : **`docs/MIGRATION.md`** · détails : **`README-INSTALL.md`**. Choix techniques et limites : **`docs/ARCHITECTURE.md`**.

**Bande passante (1.1)** : ~2,6 Mbit/s dans chaque sens en tête-à-tête 1080p (~1,3 en 720p) ; à 25, un auditeur reçoit
~3,3 Mbit/s (orateur 1080p + 8 vignettes) et le serveur émet ~80 Mbit/s au total (~28 Mbit/s en 1.0) — détail et
réglages (`VIDEO_MAX_HEIGHT`…) dans `docs/ARCHITECTURE.md`.

## Développement

```bash
npm ci && npm run vendor          # dépendances + copie de MediaPipe / QR dans public/vendor
PORT=8790 HOST=127.0.0.1 npm start
npm test                          # tests unitaires (node:test)
npx playwright test               # tests multi-navigateurs (Chrome, WebKit, Firefox) avec caméra/micro simulés
node scripts/check-headers.mjs http://127.0.0.1:8790 --https   # liste de contrôle des en-têtes
bash scripts/package.sh [/chemin]  # build+1 (fichier BUILD, à commiter) puis archives
                                  # chatsysvisio-complet-<version>-b<build>.tar.gz / chatsysvisio-mise-a-jour-<version>-b<build>.tar.gz
E2E_PORT=18790 npx playwright test  # port libre au choix (défaut 8795)
PREFIX=v2 node scripts/design-shots.mjs  # captures bureau + mobile (serveur de test sur BASE, défaut :8796)
```
