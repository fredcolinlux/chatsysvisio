// Durcissement 1.0.1 : méthodes, erreurs, divulgation de version, plafonds (sessions, connexions, quota disque), débits WebSocket.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createApp } from '../../server/app.mjs';
import { loadConfig } from '../../server/config.mjs';
import { Hub } from '../../server/hub.mjs';
import { Store } from '../../server/store.mjs';
import { hashPassword, verifyPasswordAsync } from '../../server/security.mjs';

let app, base;
before(async () => {
  const cfg = loadConfig({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hard-')), publicUrl: '', quiet: true, version: '9.9.9', build: '42',
    maxSessions: 50, roomQuotaMb: 1, uploadMaxMb: 1 });
  app = createApp(cfg);
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(() => { app.server.closeAllConnections?.(); app.server.close(); });

async function client() {
  const c = { cookie: '' };
  const r = await fetch(base + '/api/session');
  c.cookie = (r.headers.getSetCookie()[0] || '').split(';')[0]; c.csrf = (await r.json()).csrf;
  c.post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { cookie: c.cookie, origin: base, 'x-csrf-token': c.csrf, ...headers },
    body: Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body) });
  return c;
}

test('méthodes non autorisées : 405 avec en-tête Allow et en-têtes de sécurité', async () => {
  for (const m of ['PUT', 'DELETE', 'OPTIONS', 'PATCH', 'TRACE']) {
    const r = await fetch(base + '/', { method: m }).catch(() => null); if (!r) continue; // TRACE peut être refusé par le client
    assert.equal(r.status, 405, m); assert.equal(r.headers.get('allow'), 'GET, HEAD, POST');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  }
});

test('URL mal encodée : 400 (pas 500) avec en-têtes de sécurité', async () => {
  const r = await fetch(base + '/%E0%A4%A');
  assert.equal(r.status, 400); assert.ok(r.headers.get('content-security-policy'));
});

test('/healthz : version seulement en accès local direct, jamais via le proxy', async () => {
  const loc = await (await fetch(base + '/healthz')).json();
  assert.equal(loc.version, '9.9.9'); assert.equal(loc.build, '42');
  const via = await (await fetch(base + '/healthz', { headers: { 'x-forwarded-for': '203.0.113.7', 'x-forwarded-proto': 'https' } })).json();
  assert.deepEqual(via, { ok: true });
});

test('aucune bannière serveur ni CORS ouvert', async () => {
  const r = await fetch(base + '/api/session', { headers: { origin: 'https://evil.example' } });
  assert.equal(r.headers.get('server'), null); assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('access-control-allow-origin'), null);
});

test('sessions plafonnées : une inondation de visites ne fait pas grossir la mémoire, les sessions utiles survivent', async () => {
  const a = await client();
  const { slug } = await (await a.post('/api/rooms', { name: 'Gardé', isPublic: true })).json();
  for (let i = 0; i < 120; i++) await (await fetch(base + '/')).arrayBuffer(); // pages HTML : non limitées en débit, chacune crée une session
  assert.ok(app.sessions.size <= 50, `sessions : ${app.sessions.size}`);
  const sid = a.cookie.split('=')[1]; assert.ok(app.sessions.has(sid), 'la session qui a créé un salon est conservée');
  assert.ok(slug);
});

test('fichiers : quota disque par salon (507) et nom Content-Disposition encodé RFC 5987', async () => {
  const a = await client();
  const { slug } = await (await a.post('/api/rooms', { name: 'Quota', isPublic: true })).json();
  await a.post(`/api/rooms/${slug}/join`, { name: 'A' });
  const name = "l'été (1)*.txt";
  const up = await a.post(`/api/rooms/${slug}/files`, Buffer.alloc(600 * 1024, 1), { 'content-type': 'text/plain', 'x-file-name': encodeURIComponent(name) });
  assert.equal(up.status, 201); const f = await up.json();
  const d = await fetch(base + f.url, { headers: { cookie: a.cookie } });
  const cd = d.headers.get('content-disposition');
  assert.match(cd, /^attachment; filename="l'ete \(1\)\*\.txt"; filename\*=UTF-8''l%27%C3%A9t%C3%A9%20%281%29%2A\.txt$/);
  const second = await a.post(`/api/rooms/${slug}/files`, Buffer.alloc(600 * 1024, 1), { 'content-type': 'text/plain', 'x-file-name': 'b.txt' });
  assert.equal(second.status, 507);
});

test('WebSocket : au plus 4 connexions simultanées par session dans un salon', async () => {
  const a = await client();
  const { slug } = await (await a.post('/api/rooms', { name: 'Onglets', isPublic: true })).json();
  await a.post(`/api/rooms/${slug}/join`, { name: 'A' });
  const open = () => new Promise(res => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws/${slug}`, { headers: { cookie: a.cookie, origin: base } });
    ws.on('open', () => res({ ws, ok: true })); ws.on('unexpected-response', (_q, r) => res({ ws, ok: false, status: r.statusCode })); ws.on('error', () => {});
  });
  const conns = []; for (let i = 0; i < 4; i++) { const c = await open(); assert.equal(c.ok, true); conns.push(c.ws); }
  await new Promise(r => setTimeout(r, 50));
  const fifth = await open(); assert.equal(fifth.ok, false); assert.equal(fifth.status, 429);
  for (const w of conns) w.close();
});

test('mot de passe : vérification asynchrone équivalente', async () => {
  const h = hashPassword('tournesol');
  assert.equal(await verifyPasswordAsync('tournesol', h), true);
  assert.equal(await verifyPasswordAsync('autre', h), false);
  assert.equal(await verifyPasswordAsync('x', 'pas-un-hash'), false);
});

test('WebSocket : réactions, renommages et états bornés en débit (pas d\'inondation disque ni de diffusion)', () => {
  class FakeWs extends EventEmitter { constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.json = []; } send(d) { if (typeof d === 'string') this.json.push(JSON.parse(d)); } close() { this.readyState = 3; this.emit('close'); } }
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-rate-')));
  const hub = new Hub({ store, cfg: loadConfig({ quiet: true }) });
  const room = store.createRoom({ name: 'Débit', isPublic: true });
  const a = new FakeWs(), b = new FakeWs();
  hub.attach(a, { room, name: 'A', sessionId: 'a' }); hub.attach(b, { room, name: 'B', sessionId: 'b' });
  for (const w of [a, b]) w.emit('message', Buffer.from(JSON.stringify({ t: 'hello', name: 'x', caps: {}, state: {} })), false);
  a.emit('message', Buffer.from(JSON.stringify({ t: 'chat', text: 'salut' })), false);
  const id = b.json.filter(m => m.t === 'chat').at(-1).msg.id;
  const before = b.json.length;
  for (let i = 0; i < 200; i++) a.emit('message', Buffer.from(JSON.stringify({ t: 'msgreact', id, emoji: '👍' })), false);
  for (let i = 0; i < 200; i++) a.emit('message', Buffer.from(JSON.stringify({ t: 'name', name: 'N' + i })), false);
  for (let i = 0; i < 200; i++) a.emit('message', Buffer.from(JSON.stringify({ t: 'state', state: { hand: i % 2 === 0 } })), false);
  const got = b.json.slice(before);
  assert.ok(got.filter(m => m.t === 'msgreact').length <= 5, 'réactions');
  assert.ok(got.filter(m => m.t === 'peer').length <= 12, 'renommages + états');
  const lines = fs.readFileSync(path.join(store.msgDir, `${room.id}.jsonl`), 'utf8').split('\n').filter(l => l.includes('"op":"react"'));
  assert.ok(lines.length <= 5, `écritures disque : ${lines.length}`);
  a.emit('message', Buffer.from('null'), false); a.emit('message', Buffer.from('42'), false); // JSON non objet : ignoré sans erreur
  hub.close();
});
