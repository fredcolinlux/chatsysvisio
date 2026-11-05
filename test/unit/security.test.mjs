import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, RateLimiter, csp, clientIp, isHttps, tokenEq, PERMISSIONS_POLICY } from '../../server/security.mjs';
import { loadConfig } from '../../server/config.mjs';

const cfg = loadConfig({ publicUrl: '', trustedProxies: ['192.0.2.10'] });
const req = (ra, headers = {}) => ({ socket: { remoteAddress: ra }, headers: { host: 'chat.example.org', ...headers } });

test('mots de passe : scrypt salé, vérification à temps constant', () => {
  const h = hashPassword('sésame ouvre-toi');
  assert.match(h, /^scrypt\$16384\$8\$1\$/);
  assert.notEqual(h, hashPassword('sésame ouvre-toi'));
  assert.equal(verifyPassword('sésame ouvre-toi', h), true);
  assert.equal(verifyPassword('mauvais', h), false);
  assert.equal(verifyPassword('x', 'n\'importe quoi'), false);
});

test('limiteur de débit (seau à jetons)', () => {
  const l = new RateLimiter({ capacity: 3, perSec: 1 }); const t = 1_000_000;
  assert.equal([1, 2, 3, 4].map(() => l.take('ip', 1, t)).join(), 'true,true,true,false');
  assert.equal(l.take('ip', 1, t + 1100), true);
  assert.equal(l.take('autre', 1, t), true);
});

test('CSP : aucune origine externe, pas de inline, wasm seulement si demandé', () => {
  const r = req('1.2.3.4');
  const a = csp(r, cfg), b = csp(r, cfg, { wasm: true });
  assert.doesNotMatch(a, /unsafe-inline|unsafe-eval|https?:\/\/|\*/);
  assert.doesNotMatch(a, /wasm-unsafe-eval/);
  assert.match(b, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(a, /frame-ancestors 'none'/); assert.match(a, /object-src 'none'/);
});

test('IP client : X-Forwarded-For seulement depuis le proxy de confiance', () => {
  assert.equal(clientIp(req('192.0.2.10', { 'x-forwarded-for': '6.6.6.6, 9.9.9.9' }), cfg), '9.9.9.9');
  assert.equal(clientIp(req('5.5.5.5', { 'x-forwarded-for': '9.9.9.9' }), cfg), '5.5.5.5');
});

test('HTTPS détecté via X-Forwarded-Proto du proxy de confiance uniquement', () => {
  assert.equal(isHttps(req('192.0.2.10', { 'x-forwarded-proto': 'https' }), cfg), true);
  assert.equal(isHttps(req('5.5.5.5', { 'x-forwarded-proto': 'https' }), cfg), false);
});

test('Permissions-Policy : caméra/micro/capture d\'écran limités au site', () => {
  for (const f of ['camera=(self)', 'microphone=(self)', 'display-capture=(self)', 'geolocation=()']) assert.ok(PERMISSIONS_POLICY.includes(f));
  assert.equal(tokenEq('abc', 'abc'), true); assert.equal(tokenEq('abc', 'abd'), false); assert.equal(tokenEq('abc', ''), false);
});
