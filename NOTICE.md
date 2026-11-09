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
| qrcode-generator (Kazuhiko Arase) | MIT | QR code d'invitation généré localement |
| ws | MIT | serveur WebSocket |
| Police Inter (Rasmus Andersson) | SIL OFL 1.1 | typographie |

Textes des licences RNNoise : `docs/licences/` (copiés dans `public/vendor/rnnoise/`).
