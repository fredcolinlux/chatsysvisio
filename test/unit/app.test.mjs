// Tests HTTP/WebSocket de bout en bout (sans navigateur) : en-têtes, cookies, CSRF, mot de passe, limites, fichiers, limite 25.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../../server/app.mjs';
import { loadConfig } from '../../server/config.mjs';

let app, base, origin;
before(async () => {
  const cfg = loadConfig({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-')), publicUrl: '', quiet: true, maxParticipants: 25, createPer10Min: 100 });
  app = createApp(cfg);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  origin = base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }
  async req(p, { method = 'GET', body, headers = {}, raw = false } = {}) {
    const h = { ...headers }; if (this.cookie) h.cookie = this.cookie;
    if (method !== 'GET') { h.origin ??= origin; if (this.csrf) h['x-csrf-token'] ??= this.csrf; }
    if (body !== undefined && !raw) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
    const r = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
    const sc = r.headers.getSetCookie?.() || [];
    for (const c of sc) if (/^(__Host-)?csv_sid=/.test(c)) this.cookie = c.split(';')[0];
    return r;
  }
  async init() { const r = await this.req('/api/session'); this.csrf = (await r.json()).csrf; return this; }
  ws(slug) {
    return new Promise((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${slug}`, { headers: { cookie: this.cookie, origin } });
      ws.msgs = []; ws.on('message', (d, bin) => { if (!bin) ws.msgs.push(JSON.parse(d)); });
      ws.on('open', () => { ws.send(JSON.stringify({ t: 'hello', name: 'x', caps: { venc: ['vp8'], vdec: ['vp8'], aenc: ['opus'], adec: ['opus'] }, state: {} })); });
      ws.on('message', (d, bin) => { if (!bin && JSON.parse(d).t === 'welcome') resolve({ ws, ok: true }); });
      ws.on('close', code => resolve({ ws, ok: false, code }));
      ws.on('unexpected-response', (_q, res) => resolve({ ws, ok: false, status: res.statusCode }));
      ws.on('error', () => {});
    });
  }
}

test('en-têtes de sécurité sur la page d\'accueil', async () => {
  const r = await fetch(base + '/');
  const g = k => r.headers.get(k) || '';
  assert.equal(r.status, 200);
  assert.match(g('content-security-policy'), /default-src 'self'/);
  assert.doesNotMatch(g('content-security-policy'), /unsafe-inline|unsafe-eval|wasm/);
  assert.equal(g('x-frame-options'), 'DENY'); assert.equal(g('x-content-type-options'), 'nosniff');
  assert.equal(g('referrer-policy'), 'strict-origin-when-cross-origin');
  assert.equal(g('cross-origin-opener-policy'), 'same-origin'); assert.equal(g('cross-origin-embedder-policy'), 'require-corp');
  assert.equal(g('cross-origin-resource-policy'), 'same-origin');
  assert.match(g('permissions-policy'), /camera=\(self\)/);
  assert.equal(g('x-powered-by'), '');
  const html = await r.text();
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/i, 'aucun script inline');
  assert.doesNotMatch(html, /\sstyle=/i, 'aucun style inline');
});

test('HSTS servi uniquement derrière HTTPS (X-Forwarded-Proto du proxy de confiance)', async () => {
  const a = await fetch(base + '/'); assert.equal(a.headers.get('strict-transport-security'), null);
  const b = await fetch(base + '/', { headers: { 'x-forwarded-proto': 'https' } });
  assert.match(b.headers.get('strict-transport-security') || '', /max-age=63072000; includeSubDomains; preload/);
  const sc = (b.headers.getSetCookie?.() || []).join('\n');
  if (sc) for (const f of ['Path=/', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(sc.includes('; ' + f), 'drapeau ' + f);
});

test('cookie de session : HttpOnly, Secure, SameSite=Strict', async () => {
  const r = await fetch(base + '/api/session', { headers: { 'x-forwarded-proto': 'https' } });
  const c = (r.headers.getSetCookie?.() || []).find(x => x.startsWith('__Host-csv_sid='));
  assert.ok(c); for (const f of ['HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(c.includes('; ' + f), 'drapeau ' + f);
});

test('CSRF : POST refusé sans jeton ou depuis une autre origine', async () => {
  const c = await new Client().init();
  const noTok = await c.req('/api/rooms', { method: 'POST', body: { name: 'Pirate' }, headers: { 'x-csrf-token': 'faux' } });
  assert.equal(noTok.status, 403);
  const evil = await c.req('/api/rooms', { method: 'POST', body: { name: 'Pirate' }, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const ok = await c.req('/api/rooms', { method: 'POST', body: { name: 'Légitime', isPublic: true } });
  assert.equal(ok.status, 201);
});

test('salon à mot de passe : refus, puis accès, mot de passe jamais renvoyé', async () => {
  const owner = await new Client().init();
  const r = await owner.req('/api/rooms', { method: 'POST', body: { name: 'Secret', password: 'tournesol' } });
  const { slug } = await r.json();
  const guest = await new Client().init();
  const info = await (await guest.req('/api/rooms/' + slug)).json();
  assert.equal(info.hasPassword, true); assert.ok(!JSON.stringify(info).includes('scrypt'));
  assert.equal((await guest.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'G', password: 'non' } })).status, 401);
  assert.equal((await guest.ws(slug)).status, 403, 'WebSocket refusée sans avoir rejoint');
  assert.equal((await guest.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'G', password: 'tournesol' } })).status, 200);
  const w = await guest.ws(slug); assert.equal(w.ok, true); w.ws.close();
});

test('limitation de débit sur les essais de mot de passe', async () => {
  const owner = await new Client().init();
  const { slug } = await (await owner.req('/api/rooms', { method: 'POST', body: { name: 'Coffre', password: 'tournesol' } })).json();
  const g = await new Client().init(); const codes = [];
  for (let i = 0; i < 14; i++) codes.push((await g.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { password: 'x' + i } })).status);
  assert.ok(codes.includes(429), codes.join());
  assert.ok(codes.slice(0, 5).every(c => c === 401));
});

test('fichiers : réservés aux membres, en-têtes de téléchargement sûrs, HTML jamais affiché', async () => {
  const a = await new Client().init();
  const { slug } = await (await a.req('/api/rooms', { method: 'POST', body: { name: 'Partage', isPublic: true } })).json();
  await a.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'A' } });
  const up = await a.req(`/api/rooms/${slug}/files`, { method: 'POST', raw: true, body: '<script>alert(1)</script>', headers: { 'content-type': 'text/html', 'x-file-name': encodeURIComponent('piège.html') } });
  assert.equal(up.status, 201); const f = await up.json();
  const d = await a.req(f.url);
  assert.equal(d.status, 200);
  assert.equal(d.headers.get('content-type'), 'application/octet-stream');
  assert.match(d.headers.get('content-disposition'), /^attachment;/);
  assert.match(d.headers.get('content-security-policy'), /sandbox/);
  assert.equal(d.headers.get('x-content-type-options'), 'nosniff');
  const fake = await a.req(`/api/rooms/${slug}/files`, { method: 'POST', raw: true, body: 'pas une image', headers: { 'content-type': 'image/png', 'x-file-name': 'x.png' } });
  assert.equal((await fake.json()).type, 'application/octet-stream', 'image non reconnue → pas d\'affichage inline');
  const outsider = await new Client().init();
  assert.equal((await outsider.req(f.url)).status, 403);
  const big = await a.req(`/api/rooms/${slug}/files`, { method: 'POST', raw: true, body: Buffer.alloc(11 * 1024 * 1024), headers: { 'content-type': 'application/zip', 'x-file-name': 'gros.zip' } });
  assert.equal(big.status, 413);
});

test('WebSocket : origine étrangère refusée', async () => {
  const a = await new Client().init();
  const { slug } = await (await a.req('/api/rooms', { method: 'POST', body: { name: 'Origine', isPublic: true } })).json();
  await a.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'A' } });
  const res = await new Promise(resolve => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${slug}`, { headers: { cookie: a.cookie, origin: 'https://evil.example' } });
    ws.on('unexpected-response', (_q, r) => resolve(r.statusCode)); ws.on('open', () => resolve('open')); ws.on('error', () => {});
  });
  assert.equal(res, 403);
});

test('limite de 25 participants : 25 connectés, le 26e refusé (API 403 « full » et WebSocket 4003)', async () => {
  const owner = await new Client().init();
  const { slug } = await (await owner.req('/api/rooms', { method: 'POST', body: { name: 'Grande tablée', isPublic: true, limit: 25 } })).json();
  const conns = [];
  for (let i = 0; i < 25; i++) {
    const c = await new Client().init();
    assert.equal((await c.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'P' + i } })).status, 200);
    const w = await c.ws(slug); assert.equal(w.ok, true, 'participant ' + (i + 1)); conns.push(w.ws);
  }
  const st = await (await owner.req(`/api/rooms/status?slugs=${slug}`)).json();
  assert.equal(st[slug].count, 25);
  const late = await new Client().init();
  const j = await late.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'Retard' } });
  assert.equal(j.status, 403); assert.equal((await j.json()).code, 'full');
  // quelqu'un qui avait rejoint avant (session valide) mais se connecte en 26e : fermé avec 4003
  const early = await new Client().init();
  conns[0].close(); await new Promise(r => setTimeout(r, 150));
  assert.equal((await early.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'Tôt' } })).status, 200);
  const w1 = await early.ws(slug); assert.equal(w1.ok, true); conns.push(w1.ws);
  const again = await (async () => { const c = new Client(); c.cookie = owner.cookie; c.csrf = owner.csrf; await c.req(`/api/rooms/${slug}/join`, { method: 'POST', body: {} }); return c.ws(slug); })();
  assert.equal(again.ok, false); assert.equal(again.code, 4003);
  for (const c of conns) c.close();
});

test('E2EE : paramètres validés, salon public jamais chiffré, valeur de contrôle cachée avant l\'accès, fichiers opaques', async () => {
  const o = await new Client().init();
  const e2ee = mode => ({ v: 1, mode, salt: 'S'.repeat(22), iter: 600000, kcv: 'K'.repeat(22) });
  assert.equal((await o.req('/api/rooms', { method: 'POST', body: { name: 'Place', isPublic: true, e2ee: e2ee('link') } })).status, 400);
  assert.equal((await o.req('/api/rooms', { method: 'POST', body: { name: 'Mauvais mode', e2ee: e2ee('link+pw') } })).status, 400);
  assert.equal((await o.req('/api/rooms', { method: 'POST', body: { name: 'Sel court', e2ee: { ...e2ee('link'), salt: 'abc' } } })).status, 400);
  assert.equal((await o.req('/api/rooms', { method: 'POST', body: { name: 'Peu itéré', e2ee: { ...e2ee('link'), iter: 1000 } } })).status, 400);
  const { slug } = await (await o.req('/api/rooms', { method: 'POST', body: { name: 'Lien seul', e2ee: e2ee('link') } })).json();
  const g = await new Client().init();
  const info = await (await g.req('/api/rooms/' + slug)).json();
  assert.equal(info.e2ee.mode, 'link'); assert.equal(info.e2ee.kcv, 'K'.repeat(22)); assert.equal(info.ai, false);
  const pw = await (await o.req('/api/rooms', { method: 'POST', body: { name: 'Lien et mot de passe', password: 'jeton-derive-1234', e2ee: e2ee('link+pw') } })).json(); // gitleaks:allow (mot de passe de test)
  const i2 = await (await g.req('/api/rooms/' + pw.slug)).json();
  assert.equal(i2.e2ee.mode, 'link+pw'); assert.equal(i2.e2ee.kcv, undefined, 'pas de test hors ligne du mot de passe');
  assert.equal((await o.req('/api/rooms/' + pw.slug)).status, 200);
  assert.equal((await (await o.req('/api/rooms/' + pw.slug)).json()).e2ee.kcv, 'K'.repeat(22));
  await g.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'G' } });
  const up = await g.req(`/api/rooms/${slug}/files`, { method: 'POST', raw: true, body: Buffer.from('CCE1' + 'x'.repeat(40)), headers: { 'content-type': 'image/png', 'x-file-name': 'vacances.png' } });
  const f = await up.json(); assert.equal(f.name, 'fichier-chiffre.bin'); assert.equal(f.type, 'application/octet-stream');
  const s = await (await g.req('/api/session')).json(); assert.match(s.codeHash, /^[0-9a-f]{64}$/);
});

test('mise à jour : pages marquées du build, scripts et imports versionnés, service worker au cache du build', async () => {
  const cfg = loadConfig({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-app-v-')), publicUrl: '', quiet: true, build: '42', version: '9.9.9' });
  const a2 = createApp(cfg); await new Promise(r => a2.server.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${a2.server.address().port}`;
  try {
    const r = await fetch(b2 + '/r/salon-test'); const html = await r.text();
    assert.match(html, /<html lang="fr" data-build="42"/);
    assert.match(html, /src="\/js\/room\.js\?v=42"/); assert.match(html, /href="\/css\/app\.css\?v=42"/);
    assert.match(r.headers.get('cache-control'), /no-store/);
    const js = await (await fetch(b2 + '/js/room.js?v=42')).text();
    assert.match(js, /from '\.\/media\.js\?v=42'/); assert.doesNotMatch(js, /from '\.\/media\.js'/);
    const media = await (await fetch(b2 + '/js/media.js')).text();
    assert.match(media, /'\/js\/worklets\.js\?v=42'/); assert.match(media, /'\/js\/ticker\.js\?v=42'/);
    const sw = await (await fetch(b2 + '/sw.js')).text();
    assert.match(sw, /const V = '42'/); assert.doesNotMatch(sw, /__ASSET_VERSION__/);
    const s = await (await fetch(b2 + '/api/session')).json(); assert.equal(s.build, '42');
    // l'ETag change avec le build (un cache intermédiaire ne ressert pas l'ancien fichier)
    assert.match((await fetch(b2 + '/js/common.js')).headers.get('etag'), /-42"$/);
  } finally { a2.server.close(); a2.hub.close?.(); }
});
