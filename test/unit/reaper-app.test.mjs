// 1.12 : suppression automatique d'un salon public vide, à travers HTTP + WebSocket (délai court : 0,005 min = 300 ms).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../../server/app.mjs';
import { loadConfig } from '../../server/config.mjs';

let app, base, origin, dir;
const TTL_MIN = 0.005, wait = ms => new Promise(r => setTimeout(r, ms));
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reap-app-'));
  app = createApp(loadConfig({ dataDir: dir, publicUrl: '', quiet: true, createPer10Min: 100, publicRoomIdleTtlMin: TTL_MIN }));
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


test('HTTP : salon public quitté → supprimé après le délai (liste, page, fichiers, session, journal), nom réutilisable', async () => {
  const a = await new Client().init();
  const c = await a.req('/api/rooms', { method: 'POST', body: { name: 'Expire vite', isPublic: true } });
  assert.equal(c.status, 201); const { slug } = await c.json();
  const info = await (await a.req(`/api/rooms/${slug}`)).json();
  assert.equal(info.idleTtlMin, TTL_MIN, 'délai annoncé au client');
  await a.req(`/api/rooms/${slug}/join`, { method: 'POST', body: { name: 'A' } });
  const { ws, ok } = await a.ws(slug); assert.ok(ok);
  ws.send(JSON.stringify({ t: 'chat', text: 'salut' }));
  const up = await a.req(`/api/rooms/${slug}/files`, { method: 'POST', raw: true, body: 'contenu', headers: { 'content-type': 'text/plain', 'x-file-name': 'a.txt' } });
  assert.equal(up.status, 201); const file = await up.json();
  await wait(TTL_MIN * 60e3 * 2);
  assert.ok(app.store.getRoom(slug), 'occupé : conservé au-delà du délai');
  const room = app.store.getRoom(slug);
  ws.close(); await wait(50);
  const list = await (await a.req('/api/rooms/public')).json();
  const card = list.find(r => r.slug === slug); assert.ok(card); assert.equal(card.count, 0); assert.equal(card.expiresIn, 1);
  await wait(TTL_MIN * 60e3 + 200);
  assert.equal(app.store.getRoom(slug), null);
  assert.equal((await a.req(`/api/rooms/${slug}`)).status, 404);
  assert.ok(!(await (await a.req('/api/rooms/public')).json()).some(r => r.slug === slug), 'retiré de la liste publique');
  assert.equal((await a.req(file.url)).status, 404, 'pièce jointe effacée');
  assert.ok(!fs.existsSync(path.join(dir, 'messages', `${room.id}.jsonl`)), 'historique effacé');
  assert.ok(![...app.sessions.values()].some(s => s.rooms.has(room.id)), 'autorisations de session retirées');
  assert.ok(app.events.query({ type: 'salon' }).some(e => e.room === slug && /supprimé automatiquement/.test(e.msg)), 'trace dans le journal');
  const re = await a.req('/api/rooms', { method: 'POST', body: { name: 'Expire vite', isPublic: true } });
  assert.equal(re.status, 201, 'nom de nouveau libre'); assert.equal((await re.json()).slug, slug);
});

test('HTTP : salon privé et salon public à mot de passe non supprimés', async () => {
  const a = await new Client().init();
  const p = await (await a.req('/api/rooms', { method: 'POST', body: { name: 'Privé lent' } })).json();
  const q = await (await a.req('/api/rooms', { method: 'POST', body: { name: 'Public protégé', isPublic: true, password: 'tournesol' } })).json();
  const info = await (await a.req(`/api/rooms/${p.slug}`)).json(); assert.equal(info.idleTtlMin, undefined);
  for (const sl of [p.slug, q.slug]) { await a.req(`/api/rooms/${sl}/join`, { method: 'POST', body: { name: 'A', password: 'tournesol' } }); const { ws, ok } = await a.ws(sl); assert.ok(ok); ws.close(); }
  await wait(TTL_MIN * 60e3 * 3);
  assert.ok(app.store.getRoom(p.slug)); assert.ok(app.store.getRoom(q.slug));
});
