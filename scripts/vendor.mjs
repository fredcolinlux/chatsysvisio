// Copie les dépendances front (MediaPipe, QR code, RNNoise) et le modèle de segmentation dans public/vendor.
// Tout est servi par ton serveur : aucune ressource externe au chargement.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const nm = path.join(root, 'node_modules');
const out = path.join(root, 'public', 'vendor');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'mediapipe', 'wasm'), { recursive: true });
const mp = path.join(nm, '@mediapipe', 'tasks-vision');
const strip = s => s.replace(/\n\/\/# sourceMappingURL=.*\s*$/, '\n');
fs.writeFileSync(path.join(out, 'mediapipe', 'vision_bundle.mjs'), strip(fs.readFileSync(path.join(mp, 'vision_bundle.mjs'), 'utf8')));
for (const f of ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm'])
  fs.copyFileSync(path.join(mp, 'wasm', f), path.join(out, 'mediapipe', 'wasm', f));
fs.copyFileSync(path.join(mp, 'LICENSE').replace(/LICENSE$/, 'package.json'), path.join(out, 'mediapipe', 'package.json'));
fs.copyFileSync(path.join(root, 'models', 'selfie_segmenter.tflite'), path.join(out, 'mediapipe', 'selfie_segmenter.tflite'));
fs.copyFileSync(path.join(nm, 'qrcode-generator', 'dist', 'qrcode.mjs'), path.join(out, 'qrcode.mjs'));
// Réduction de bruit RNNoise (wasm + AudioWorklet), avec ses licences (MIT, Apache-2.0, BSD-3-Clause)
const ns = path.join(nm, '@sapphi-red', 'web-noise-suppressor', 'dist');
fs.mkdirSync(path.join(out, 'rnnoise'), { recursive: true });
fs.writeFileSync(path.join(out, 'rnnoise', 'rnnoise-worklet.js'), strip(fs.readFileSync(path.join(ns, 'rnnoise', 'workletProcessor.js'), 'utf8')));
for (const f of ['rnnoise.wasm', 'rnnoise_simd.wasm']) fs.copyFileSync(path.join(ns, f), path.join(out, 'rnnoise', f));
for (const f of fs.readdirSync(path.join(root, 'docs', 'licences'))) fs.copyFileSync(path.join(root, 'docs', 'licences', f), path.join(out, 'rnnoise', f));
fs.writeFileSync(path.join(out, 'LICENCES.txt'), [
  '@mediapipe/tasks-vision — Apache License 2.0 — https://github.com/google-ai-edge/mediapipe',
  'Modèle selfie_segmenter.tflite (MediaPipe) — Apache License 2.0',
  '@sapphi-red/web-noise-suppressor 0.4.1 (worklet RNNoise) — MIT — https://github.com/sapphi-red/web-noise-suppressor',
  '@shiguredo/rnnoise-wasm (compilation wasm de RNNoise) — Apache License 2.0 — https://github.com/shiguredo/rnnoise-wasm',
  'RNNoise (Jean-Marc Valin, Xiph.Org, Mozilla) — BSD-3-Clause — https://github.com/xiph/rnnoise',
  'Textes complets : vendor/rnnoise/*.txt',
  'qrcode-generator — MIT — Kazuhiko Arase — https://github.com/kazuhikoarase/qrcode-generator',
  'Police Inter — SIL Open Font License 1.1 (voir public/fonts/LICENCE-Inter.txt)',
].join('\n') + '\n');
console.log('vendor : OK →', path.relative(root, out));
