import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = path.resolve('scripts/chatsysvisio-admin.mjs');
const run = args => { try { return { code: 0, out: execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } };

test('la commande est trouvée même quand --data-dir DIR est passé en premier (comme le fait le wrapper)', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-admin-'));
  const r = run(['--data-dir', d, 'list']);
  assert.equal(r.code, 0);
  assert.match(r.out, /Aucun administrateur/);
  const r2 = run(['--data-dir', d, 'reset-password', '--user', 'inconnu']);
  assert.equal(r2.code, 1);
  assert.match(r2.out, /introuvable/);
  assert.doesNotMatch(r2.out, /gestion des administrateurs/);
  const r3 = run(['--user', 'inconnu', '--data-dir', d, 'delete']);
  assert.match(r3.out, /introuvable/);
});

test('sameOrigin accepte http://localhost:PORT seulement via la boucle locale (tunnel SSH)', async () => {
  const { sameOrigin } = await import('../../server/security.mjs');
  const cfg = { publicUrl: 'https://chat.exemple.fr', trustedProxies: [] };
  const mk = (ra, host, origin, xff) => ({ socket: { remoteAddress: ra }, headers: { host, origin, ...(xff ? { 'x-forwarded-for': xff } : {}) } });
  assert.equal(sameOrigin(mk('127.0.0.1', 'localhost:8790', 'http://localhost:8790'), cfg), true);
  assert.equal(sameOrigin(mk('::ffff:127.0.0.1', '127.0.0.1:8790', 'http://127.0.0.1:8790'), cfg), true);
  assert.equal(sameOrigin(mk('192.0.2.10', 'localhost:8790', 'http://localhost:8790'), cfg), false);
  assert.equal(sameOrigin(mk('127.0.0.1', 'localhost:8790', 'http://localhost:8790', '1.2.3.4'), cfg), false);
  assert.equal(sameOrigin(mk('127.0.0.1', 'localhost:8790', 'http://evil.example'), cfg), false);
  assert.equal(sameOrigin(mk('192.0.2.10', 'chat.exemple.fr', 'https://chat.exemple.fr'), cfg), true);
});
