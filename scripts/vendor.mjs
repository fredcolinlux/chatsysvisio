// Copie les dépendances front (MediaPipe, QR code, RNNoise, DeepFilterNet3) et le modèle de segmentation dans public/vendor.
// Tout est servi par ton serveur : aucune ressource externe au chargement.
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
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
// Isolateur de voix (1.9) : DeepFilterNet3 (libDF compilé en wasm SIMD, poids intégrés), MIT OU Apache-2.0.
// Fichier de 34 Mo : seules ses versions précompressées sont servies (brotli ≈ 10,7 Mo, gzip ≈ 12,7 Mo), chargées
// uniquement quand l'interrupteur est activé.
{
  const dfp = path.join(nm, '@lofcz', 'deepfilternet-web'), dir = path.join(out, 'deepfilter');
  fs.mkdirSync(dir, { recursive: true });
  const raw = fs.readFileSync(path.join(dfp, 'dist', 'df_bg.wasm'));
  const cache = path.join(root, 'runtime', 'vendor-cache'); fs.mkdirSync(cache, { recursive: true });
  const sha = crypto.createHash('sha256').update(raw).digest('hex'), cbr = path.join(cache, sha + '.br');
  if (!fs.existsSync(cbr)) fs.writeFileSync(cbr, zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }));
  fs.copyFileSync(cbr, path.join(dir, 'df_bg.wasm.br'));
  fs.writeFileSync(path.join(dir, 'df_bg.wasm.gz'), zlib.gzipSync(raw, { level: 9 }));
  const pkg = JSON.parse(fs.readFileSync(path.join(dfp, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'info.json'), JSON.stringify({ name: pkg.name, version: pkg.version, size: raw.length, sha256: sha }) + '\n');
  for (const f of ['LICENSE', 'LICENSE-MIT', 'LICENSE-APACHE']) fs.copyFileSync(path.join(dfp, f), path.join(dir, f + '.txt'));
}
fs.writeFileSync(path.join(out, 'LICENCES.txt'), [
  '@mediapipe/tasks-vision — Apache License 2.0 — https://github.com/google-ai-edge/mediapipe',
  'Modèle selfie_segmenter.tflite (MediaPipe) — Apache License 2.0',
  '@sapphi-red/web-noise-suppressor 0.4.1 (worklet RNNoise) — MIT — https://github.com/sapphi-red/web-noise-suppressor',
  '@shiguredo/rnnoise-wasm (compilation wasm de RNNoise) — Apache License 2.0 — https://github.com/shiguredo/rnnoise-wasm',
  'RNNoise (Jean-Marc Valin, Xiph.Org, Mozilla) — BSD-3-Clause — https://github.com/xiph/rnnoise',
  'Textes complets : vendor/rnnoise/*.txt',
  '@lofcz/deepfilternet-web 0.1.0 (libDF de DeepFilterNet, wasm SIMD, poids DeepFilterNet3 intégrés) — MIT OU Apache-2.0 — https://github.com/lofcz/DeepFilterNet',
  'DeepFilterNet / DeepFilterNet3 (Hendrik Schröter et contributeurs) — MIT OU Apache-2.0 — https://github.com/Rikorose/DeepFilterNet',
  'Textes : vendor/deepfilter/LICENSE*.txt',
  'qrcode-generator — MIT — Kazuhiko Arase — https://github.com/kazuhikoarase/qrcode-generator',
  'Police Inter — SIL Open Font License 1.1 (voir public/fonts/LICENCE-Inter.txt)',
].join('\n') + '\n');
console.log('vendor : OK →', path.relative(root, out));
