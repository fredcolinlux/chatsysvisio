#!/usr/bin/env node
// Calcule l'empreinte du dossier public/ d'une archive, à comparer avec celle affichée dans un salon
// (cadenas « Chiffré de bout en bout » → « Empreinte du code »).  Usage : node scripts/code-hash.mjs [public]
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codeHash } from '../server/codehash.mjs';
const dir = path.resolve(process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'));
const r = codeHash(dir);
if (!r) { console.error('Dossier introuvable :', dir); process.exit(1); }
console.log(`${r.hash}  (${r.files} fichiers, ${dir})`);
