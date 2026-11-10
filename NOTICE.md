# Mentions et licences

**ChatSysVisio** est une œuvre dérivée de **Camus** (https://github.com/camuschat/camus),
© Morgan Robertson et contributeurs, distribué sous licence **GNU Affero General Public License v3.0**.

ChatSysVisio reste sous **AGPL-3.0-or-later** (voir `LICENSE`). Conformément à l'article 13 de l'AGPL,
le code source complet de la version en service est téléchargeable depuis l'application elle-même :
`/source.tar.gz` (lien « Code source (AGPL) » en bas de la barre latérale).

Repris de Camus : le concept et les fonctionnalités (salons publics/privés, mot de passe de salon,
limite de participants, page des salons publics, vidéo, partage d'écran, plein écran, image dans l'image, chat texte).
Le code a été réécrit (serveur Node.js, transport média WebSocket, nouvelle interface).

Composants tiers servis localement :

| Composant | Licence | Usage |
|---|---|---|
| @mediapipe/tasks-vision + modèle selfie_segmenter | Apache-2.0 (Google) | détourage pour flou / arrière-plan |
| RNNoise (Jean-Marc Valin, Xiph.Org, Mozilla) | BSD-3-Clause | réduction de bruit du micro (wasm local) |
| @shiguredo/rnnoise-wasm | Apache-2.0 | compilation WebAssembly de RNNoise |
| @sapphi-red/web-noise-suppressor | MIT | AudioWorklet RNNoise |
| DeepFilterNet3 (Hendrik Schröter et contributeurs) — code libDF **et poids du modèle** | MIT OU Apache-2.0 (au choix ; le dépôt précise que « tout le code et les poids des modèles » sont sous cette double licence) | isolateur de voix (modèle exécuté sur l'appareil) |
| @lofcz/deepfilternet-web 0.1.0 — compilation WebAssembly SIMD de libDF, poids DeepFilterNet3 intégrés au fichier `df_bg.wasm` ; contient aussi le moteur d'inférence **tract** 0.23 (Sonos) et des bibliothèques Rust courantes | MIT OU Apache-2.0 | isolateur de voix (wasm local, servi précompressé brotli / gzip, jamais depuis un CDN) |
| qrcode-generator (Kazuhiko Arase) | MIT | QR code d'invitation généré localement |
| ws | MIT | serveur WebSocket |
| Police Inter (Rasmus Andersson) | SIL OFL 1.1 | typographie |

Textes des licences RNNoise : `docs/licences/` (copiés dans `public/vendor/rnnoise/`).
Textes des licences DeepFilterNet (MIT et Apache-2.0) : `docs/licences/DeepFilterNet-LICENSE-*.txt` (copiés dans `public/vendor/deepfilter/`).
Les licences MIT et Apache-2.0 sont compatibles avec l'AGPL-3.0 : le tout reste distribuable sous AGPL-3.0-or-later.

Code propre à ChatSysVisio (AGPL-3.0-or-later, aucun code tiers) :

| Module | Contenu |
|---|---|
| `public/js/autotune.js`, `public/js/autotune-worklet.js` | autotune : détection de hauteur par la méthode **YIN** (A. de Cheveigné et H. Kawahara, *JASA* 111(4), 2002) et transposition à durée constante par fenêtres synchrones de la période (famille **PSOLA**, deux têtes de lecture en quadrature), correction vers la note de la gamme. Implémentation originale à partir des publications. Les brevets connus sur la TD-PSOLA (1989) et sur la correction de hauteur en temps réel (Antares, US 5 973 252 de 1998) ont expiré. « Auto-Tune » est une marque d'Antares Audio Technologies : ici, le mot « autotune » désigne seulement la fonction, sans lien avec ce produit. |
| `public/js/isolateur.js`, `public/js/isolateur-worklet.js` | isolateur de voix : découpage en trames de 10 ms autour de DeepFilterNet3, rééchantillonnage d'Hermite (44,1 kHz ↔ 48 kHz), porte de « proximité » (atténue ce qui est nettement plus faible que la voix principale pendant ses pauses), délai compensé, détection de surcharge. |
| `public/js/df-glue.js` | liaison minimale avec le wasm DeepFilterNet (remplace la colle générée par wasm-bindgen, utilisable dans un AudioWorklet). |
| `server/app.mjs` (envoi précompressé) | sert `public/vendor/` en `.br` ou `.gz` selon `Accept-Encoding` (décompression à la volée sinon). |
| `scripts/voix-synthese.mjs` | voix chantée et parlée de synthèse (formants), musique de synthèse et voix « lointaine » réverbérée, pour les tests et les extraits de démonstration (aucun enregistrement, aucun droit). |
