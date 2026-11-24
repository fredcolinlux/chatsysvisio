// 1.13 : lecteur YouTube partagé — analyse des liens, validation, synchronisation, droits, volume local, serveur.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { EventEmitter } from 'node:events';
import { parseYouTube, parseTime, validState, cleanState, expectedPos, driftAction, canControl, canOpen, cleanVolume, loadVolume, saveVolume, VOL_KEY, embedUrl, errorMessage, nearestRate, ID_RE } from '../../public/js/youtube-model.js';
import { Hub } from '../../server/hub.mjs';
import { Store } from '../../server/store.mjs';
import { loadConfig } from '../../server/config.mjs';
import { csp, permissionsPolicy, securityHeaders } from '../../server/security.mjs';

const ID = 'dQw4w9WgXcQ';
test('liens YouTube : tous les formats courants, avec ou sans t=', () => {
  const ok = [
    [`https://www.youtube.com/watch?v=${ID}`, 0], [`https://youtube.com/watch?v=${ID}&t=42`, 42], [`http://m.youtube.com/watch?feature=share&v=${ID}`, 0],
    [`https://youtu.be/${ID}`, 0], [`https://youtu.be/${ID}?t=1m30s`, 90], [`youtu.be/${ID}?si=abc&t=2h`, 7200],
    [`https://www.youtube.com/shorts/${ID}`, 0], [`https://www.youtube.com/live/${ID}?feature=share`, 0], [`https://www.youtube.com/embed/${ID}?start=15`, 15],
    [`https://www.youtube-nocookie.com/embed/${ID}`, 0], [`https://music.youtube.com/watch?v=${ID}&list=x`, 0], [`https://www.youtube.com/watch?v=${ID}#t=1:02`, 62], [ID, 0], [`  ${ID}  `, 0],
  ];
  for (const [u, t] of ok) assert.deepEqual(parseYouTube(u), { id: ID, t }, u);
  const bad = ['', 'bonjour', `https://evil.example/watch?v=${ID}`, `https://youtube.com.evil.example/watch?v=${ID}`, `https://www.youtube.com/watch?v=${ID}x`,
    `https://www.youtube.com/watch?v=abc`, `javascript:alert(1)//youtu.be/${ID}`, `https://user:pw@youtube.com/watch?v=${ID}`, `https://youtube.com:8443/watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID.slice(0, 10)}<`, `https://www.youtube.com/channel/UC12345678901`, `ftp://youtu.be/${ID}`, 'x'.repeat(3000), null, undefined, 42];
  for (const u of bad) assert.equal(parseYouTube(u), null, String(u).slice(0, 60));
  assert.equal(parseTime('1h2m3s'), 3723); assert.equal(parseTime('90'), 90); assert.equal(parseTime('1:02:03'), 3723); assert.equal(parseTime('abc'), null); assert.equal(parseTime('99999999'), 43200);
});

test('identifiant et état : validation stricte (11 caractères, champs connus seulement)', () => {
  assert.ok(ID_RE.test(ID)); for (const x of ['', 'a'.repeat(10), 'a'.repeat(12), 'abc/def.ghi', 'aaaaaaaaaa<']) assert.ok(!ID_RE.test(x));
  const s = { id: ID, pos: 12.5, play: true, rate: 1, n: 3 };
  assert.ok(validState(s));
  for (const bad of [{ ...s, id: 'x' }, { ...s, pos: -1 }, { ...s, pos: NaN }, { ...s, pos: 1e9 }, { ...s, play: 'oui' }, { ...s, rate: 3 }, { ...s, rate: 1.1 }, { ...s, n: -1 }, { ...s, n: 1.5 },
    { ...s, url: 'https://evil' }, { ...s, vol: 50 }, null, [], 'x']) assert.ok(!validState(bad), JSON.stringify(bad));
  assert.deepEqual(cleanState({ ...s, pos: 12.3456 }), { id: ID, pos: 12.35, play: true, rate: 1, n: 3 });
  assert.equal(nearestRate(1.49), 1.5); assert.equal(nearestRate(7), 2);
});

test('synchronisation : position attendue, correction de dérive au-delà de 1,5 s, pas pendant un chargement', () => {
  const s = { id: ID, pos: 100, play: true, rate: 1.5, n: 1 };
  assert.equal(expectedPos(s, 2000), 103);
  assert.equal(expectedPos({ ...s, play: false }, 60000), 100);
  assert.equal(driftAction({ expected: 103, actual: 102 }), 'none');
  assert.equal(driftAction({ expected: 103, actual: 101.2 }), 'seek');
  assert.equal(driftAction({ expected: 103, actual: 106 }), 'seek');
  assert.equal(driftAction({ expected: 103, actual: 90, buffering: true }), 'none');
  assert.equal(driftAction({ expected: 103, actual: 90, sinceSeekMs: 500 }), 'none', 'pas de rafale de sauts');
  assert.equal(driftAction({ expected: 103, actual: NaN }), 'none');
});

test('droits : une seule personne partage et pilote ; les autres sont refusés avec un message clair', () => {
  const share = { owner: 'a1', ownerName: 'Alice' };
  assert.ok(canControl(share, 'a1')); assert.ok(!canControl(share, 'b2')); assert.ok(!canControl(null, 'a1'));
  assert.deepEqual(canOpen(null, 'b2'), { ok: true });
  assert.deepEqual(canOpen(share, 'a1'), { ok: true, change: true });
  const r = canOpen(share, 'b2'); assert.equal(r.ok, false); assert.match(r.message, /Alice partage déjà une vidéo YouTube : il faut d'abord qu'il arrête son partage/);
});

test('volume : local, borné, retenu dans le navigateur, valeurs par défaut sûres', () => {
  const mem = new Map(), st = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(loadVolume(st), { v: 80, m: false });
  assert.deepEqual(saveVolume(st, { v: 33.4, m: true }), { v: 33, m: true });
  assert.deepEqual(JSON.parse(mem.get(VOL_KEY)), { v: 33, m: true });
  assert.deepEqual(loadVolume(st), { v: 33, m: true });
  assert.deepEqual(cleanVolume({ v: 400, m: 'oui' }), { v: 100, m: false });
  mem.set(VOL_KEY, '{abîmé'); assert.deepEqual(loadVolume(st), { v: 80, m: false });
});

test('lecteur intégré : youtube-nocookie, identifiant seul, lecture en ligne, API postMessage', () => {
  const u = new URL(embedUrl(ID, { origin: 'https://chat.example', start: 42.7, controls: false }));
  assert.equal(u.origin, 'https://www.youtube-nocookie.com'); assert.equal(u.pathname, `/embed/${ID}`);
  for (const [k, v] of Object.entries({ enablejsapi: '1', playsinline: '1', rel: '0', controls: '0', disablekb: '1', origin: 'https://chat.example', start: '42' })) assert.equal(u.searchParams.get(k), v, k);
  assert.equal(u.searchParams.get('autoplay'), null, 'pas d\'autoplay imposé');
  assert.throws(() => embedUrl('../../x'));
  assert.match(errorMessage(150), /n'autorise pas sa lecture en dehors de YouTube/); assert.equal(errorMessage(101), errorMessage(150));
  assert.match(errorMessage(100), /introuvable/);
});

// ---------------- serveur ----------------
class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.json = []; }
  send(d) { if (typeof d === 'string') this.json.push(JSON.parse(d)); }
  close() { this.readyState = 3; this.emit('close'); }
  all(t, op) { return this.json.filter(m => m.t === t && (!op || m.op === op)); }
  last(t, op) { return this.all(t, op).at(-1); }
}
function setup({ e2ee = false, cfg = {} } = {}) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-yt-')));
  const hub = new Hub({ store, cfg: loadConfig({ quiet: true, ...cfg }) });
  const room = store.createRoom({ name: 'YT', isPublic: !e2ee, ...(e2ee ? { e2ee: { mode: 'link', salt: 'c2FsdA', iter: 1, kcv: 'a' } } : {}) });
  const join = name => { const ws = new FakeWs(); const p = hub.attach(ws, { room, name, sessionId: name }); ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', name, proto: 99, state: {} })), false); return { ws, p }; };
  const say = (x, m) => x.ws.emit('message', Buffer.from(JSON.stringify(m)), false);
  return { hub, room, join, say };
}
const S0 = { id: ID, pos: 10, play: true, rate: 1, n: 0 };

test('serveur : partage unique, état relayé sans écho, rejoué pour qui arrive (position, lecture, vitesse)', async () => {
  const { hub, join, say } = setup();
  const a = join('A'), b = join('B');
  say(a, { t: 'yt', op: 'open', s: S0 });
  const o = b.ws.last('yt', 'open'); assert.deepEqual(o.share, { owner: a.p.id, ownerName: 'A' }); assert.deepEqual(o.s, S0);
  assert.ok(a.ws.last('yt', 'open'), 'la personne qui partage reçoit aussi l\'ouverture');
  say(a, { t: 'yt', op: 'state', s: { ...S0, pos: 50, rate: 1.5, n: 1 } });
  assert.equal(b.ws.last('yt', 'state').s.pos, 50); assert.equal(b.ws.last('yt', 'state').s.rate, 1.5);
  assert.equal(a.ws.all('yt', 'state').length, 0, 'pas d\'écho');
  await new Promise(r => setTimeout(r, 60));
  const c = join('C');
  const st = c.ws.last('yt', 'state');
  assert.equal(st.s.id, ID); assert.equal(st.s.pos, 50); assert.equal(st.s.play, true); assert.equal(st.s.rate, 1.5); assert.ok(st.age >= 50, 'âge de l\'état pour extrapoler la position');
  assert.ok(c.ws.json.findIndex(m => m.t === 'welcome') < c.ws.json.findIndex(m => m.t === 'yt'));
  hub.close();
});

test('serveur : seule la personne qui partage pilote, change ou arrête ; les autres sont refusés', () => {
  const { hub, join, say } = setup();
  const a = join('A'), b = join('B');
  say(a, { t: 'yt', op: 'open', s: S0 });
  say(b, { t: 'yt', op: 'open', s: { ...S0, id: 'aqz-KE-bpKQ' } });
  const e = b.ws.last('error'); assert.equal(e.code, 'yt-busy'); assert.match(e.message, /A partage déjà une vidéo YouTube : il faut d'abord qu'il arrête son partage/);
  const n = a.ws.all('yt').length;
  say(b, { t: 'yt', op: 'state', s: { ...S0, pos: 999, play: false } }); say(b, { t: 'yt', op: 'close' });
  assert.equal(a.ws.all('yt').length, n, 'état et arrêt d\'un spectateur ignorés');
  // changement de vidéo par la personne qui partage
  say(a, { t: 'yt', op: 'open', s: { ...S0, id: 'aqz-KE-bpKQ', pos: 0 } });
  assert.equal(b.ws.last('yt', 'open').s.id, 'aqz-KE-bpKQ');
  say(a, { t: 'yt', op: 'close' }); assert.ok(b.ws.last('yt', 'close'));
  say(b, { t: 'yt', op: 'open', s: S0 }); assert.equal(a.ws.last('yt', 'open').share.owner, b.p.id, 'libre après l\'arrêt');
  hub.close();
});

test('serveur : le partage s\'arrête quand la personne qui partage quitte le salon', () => {
  const { hub, join, say } = setup();
  const a = join('A'), b = join('B');
  say(a, { t: 'yt', op: 'open', s: S0 });
  a.ws.close();
  assert.ok(b.ws.last('yt', 'close'));
  assert.ok(b.ws.all('chat').some(m => /Partage YouTube de A arrêté/.test(m.msg?.text || '')));
  const c = join('C'); assert.equal(c.ws.all('yt').length, 0);
  hub.close();
});

test('serveur : états invalides et URL arbitraires refusés ; le volume ne transite jamais', async () => {
  const { hub, join, say } = setup();
  const a = join('A'), b = join('B');
  for (const s of [{ ...S0, id: 'https://evil.example/x' }, { ...S0, url: 'https://evil' }, { ...S0, vol: 30 }, { ...S0, rate: 9 }, null])
    say(a, { t: 'yt', op: 'open', s });
  assert.equal(b.ws.all('yt').length, 0); assert.equal(a.ws.last('error').code, 'yt');
  await new Promise(r => setTimeout(r, 1100)); // débit des ouvertures : 5 par seconde
  say(a, { t: 'yt', op: 'open', s: S0, vol: 20, url: 'https://evil' });
  const o = b.ws.last('yt', 'open'); assert.equal(JSON.stringify(o).includes('evil'), false); assert.equal('vol' in o || 'vol' in o.s, false);
  say(a, { t: 'yt', op: 'state', s: { ...S0, vol: 20 } }); assert.equal(b.ws.all('yt', 'state').length, 0, 'champ inconnu (volume) refusé');
  hub.close();
});

test('serveur : salon chiffré — état opaque relayé tel quel, droits identiques', () => {
  const { hub, join, say } = setup({ e2ee: true });
  const a = join('A'), b = join('B');
  say(a, { t: 'yt', op: 'open', s: S0 }); assert.equal(b.ws.all('yt').length, 0, 'état en clair refusé dans un salon chiffré');
  say(a, { t: 'yt', op: 'open', enc: 'Q2hpZmZyZQ' });
  const o = b.ws.last('yt', 'open'); assert.equal(o.enc, 'Q2hpZmZyZQ'); assert.equal(o.s, undefined);
  say(a, { t: 'yt', op: 'state', enc: 'RXRhdDI' }); assert.equal(b.ws.last('yt', 'state').enc, 'RXRhdDI');
  say(b, { t: 'yt', op: 'state', enc: 'UGlyYXRl' }); assert.equal(a.ws.all('yt', 'state').length, 0);
  say(a, { t: 'yt', op: 'state', enc: 'pas base64 !' }); assert.equal(b.ws.last('yt', 'state').enc, 'RXRhdDI');
  const c = join('C'); assert.equal(c.ws.last('yt', 'state').enc, 'RXRhdDI');
  hub.close();
});

test('serveur : YOUTUBE_ENABLED=0 désactive le partage', () => {
  const { hub, join, say } = setup({ cfg: { youtubeEnabled: false } });
  const a = join('A'), b = join('B');
  assert.equal(a.ws.last('welcome').yt, false);
  say(a, { t: 'yt', op: 'open', s: S0 }); assert.equal(b.ws.all('yt').length, 0);
  hub.close();
});

test('en-têtes : seule la page d\'appel autorise le cadre youtube-nocookie, sans script tiers', () => {
  const req = { socket: {}, headers: { host: 'localhost:8790' } }, cfg = loadConfig({ quiet: true });
  const room = csp(req, cfg, { wasm: true, youtube: true }), home = csp(req, cfg);
  assert.match(room, /frame-src https:\/\/www\.youtube-nocookie\.com(;|$)/);
  assert.match(room, /script-src 'self' 'wasm-unsafe-eval';/); assert.ok(!/youtube\.com\/(iframe_api|s\/player)/.test(room));
  assert.ok(!/frame-src/.test(home)); assert.match(home, /frame-ancestors 'none'/); assert.match(room, /frame-ancestors 'none'/);
  assert.match(permissionsPolicy({ youtube: true }), /autoplay=\(self "https:\/\/www\.youtube-nocookie\.com"\)/);
  assert.match(permissionsPolicy(), /autoplay=\(self\),/);
  const headers = o => { const h = {}; securityHeaders(req, { setHeader: (k, v) => { h[k.toLowerCase()] = v; }, removeHeader() {} }, cfg, o); return h; };
  assert.equal(headers({})['cross-origin-embedder-policy'], 'require-corp');
  const r = headers({ wasm: true, youtube: true });
  assert.equal(r['cross-origin-embedder-policy'], undefined); assert.equal(r['cross-origin-opener-policy'], 'same-origin'); assert.equal(r['x-frame-options'], 'DENY');
  const off = (() => { const h = {}; securityHeaders(req, { setHeader: (k, v) => { h[k.toLowerCase()] = v; }, removeHeader() {} }, loadConfig({ quiet: true, youtubeEnabled: false }), { youtube: true }); return h; })();
  assert.equal(off['cross-origin-embedder-policy'], 'require-corp'); assert.ok(!/frame-src/.test(off['content-security-policy']));
});
