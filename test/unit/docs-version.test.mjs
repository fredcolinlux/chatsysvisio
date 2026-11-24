// Les exemples d'installation et de mise à jour de la doc citent la version courante (fichier VERSION).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root = new URL('../../', import.meta.url);
const V = fs.readFileSync(new URL('VERSION', root), 'utf8').trim();
const DOCS = ['README.md', 'README.fr.md', 'README-INSTALL.md', 'docs/MANUEL.md', 'docs/MIGRATION.md'];
test('doc : exemples de commandes à la version courante', () => {
  let n = 0;
  for (const d of DOCS) {
    const s = fs.readFileSync(new URL(d, root), 'utf8');
    for (const m of s.matchAll(/\bV=(\d+\.\d+\.\d+)/g)) { n++; assert.equal(m[1], V, `${d} : V=${m[1]} au lieu de ${V}`); }
    for (const m of s.matchAll(/chatsysvisio-mise-a-jour-(\d+\.\d+\.\d+)-b\d+/g)) { n++; assert.equal(m[1], V, `${d} : archive ${m[0]}`); }
    for (const m of s.matchAll(/chatsysvisio-(\d+\.\d+\.\d+)\.tar\.gz/g)) assert.fail(`${d} : version figée ${m[0]} (utiliser V=… / $V)`);
  }
  assert.ok(n >= 6, 'exemples versionnés introuvables');
  const m = fs.readFileSync(new URL('docs/MANUEL.md', root), 'utf8').match(/\*Version (\d+\.\d+\.\d+) /);
  assert.equal(m?.[1], V, 'en-tête du manuel');
});
