// Empreinte du code servi aux navigateurs (SHA-256 sur public/ : HTML, JS, CSS, WASM…).
// Elle permet de comparer ce que le serveur sert avec une archive de confiance : `node scripts/code-hash.mjs public`.
// Limite : un serveur compromis peut annoncer une fausse empreinte ; voir docs/ARCHITECTURE.md.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EXT = /\.(html|js|mjs|css|wasm|webmanifest|json|tflite|binarypb)$/i;
export function codeHash(dir) {
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f); else if (EXT.test(e.name)) files.push(f);
  } };
  try { walk(dir); } catch { return null; }
  const h = crypto.createHash('sha256');
  for (const f of files) h.update(path.relative(dir, f).split(path.sep).join('/') + '\0' + crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') + '\n');
  return { hash: h.digest('hex'), files: files.length };
}
