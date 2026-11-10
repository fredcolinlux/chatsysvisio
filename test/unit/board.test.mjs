// 1.7 : accusés de lecture « Vu » et tableau blanc partagé (modèle commun + validation côté serveur).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Hub } from '../../server/hub.mjs';
import { Store } from '../../server/store.mjs';
import { loadConfig } from '../../server/config.mjs';
import { validStroke, cleanStroke, newId, keepPoint, W, H, MAX_PTS, LIMITS, ID_RE } from '../../public/js/board-model.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.json = []; }
  send(d) { if (typeof d === 'string') this.json.push(JSON.parse(d)); }
  close(code) { this.readyState = 3; this.emit('close'); }
  last(t, op) { return this.json.filter(m => m.t === t && (!op || m.op === op)).at(-1); }
  all(t, op) { return this.json.filter(m => m.t === t && (!op || m.op === op)); }
}
const E2 = { v: 1, mode: 'link', salt: 'A'.repeat(22), iter: 600000, kcv: 'B'.repeat(22) };
function setup({ e2ee = false } = {}) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-board-')));
  const hub = new Hub({ store, cfg: loadConfig({ quiet: true }) });
  const room = store.createRoom({ name: 'Board', isPublic: !e2ee, e2ee: e2ee ? E2 : null });
  const join = (name, sessionId = name) => {
    const ws = new FakeWs(); const p = hub.attach(ws, { room, name, sessionId });
    ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', name, proto: 2, caps: { venc: ['vp8'], vdec: ['vp8'], aenc: ['opus'], adec: ['opus'] }, state: {} })), false);
    return { ws, p };
  };
  const say = (who, m) => { who.p.rates = {}; who.ws.emit('message', Buffer.from(JSON.stringify(m)), false); };
  return { hub, store, room, join, say };
}
const stroke = (over = {}) => ({ id: newId(), k: 'pen', c: 1, w: 5, p: [10, 20, 300, 400, 500, 600], ...over });

// ---------------- modèle ----------------
test('modèle : identifiants, traits valides et refus des entrées malformées', () => {
  for (let i = 0; i < 50; i++) assert.match(newId(), ID_RE);
  assert.ok(validStroke(stroke()));
  assert.ok(validStroke(stroke({ pr: true, p: [1, 2, 50, 3, 4, 100] })));
  assert.ok(validStroke(stroke({ k: 'rect', p: [0, 0, W, H] })));
  assert.ok(validStroke(stroke({ n: 3 }), { live: true }));
  const bad = [
    null, [], 'x', stroke({ id: 'AB' }), stroke({ id: '<script>' }), stroke({ k: 'laser' }), stroke({ c: 9 }), stroke({ c: -1 }), stroke({ w: 0 }), stroke({ w: 61 }),
    stroke({ p: [] }), stroke({ p: [1, 2, 3] }), stroke({ p: [W + 1, 0] }), stroke({ p: [0, H + 1] }), stroke({ p: [1.5, 2] }), stroke({ p: ['1', 2] }),
    stroke({ k: 'line', p: [1, 2, 3, 4, 5, 6] }), stroke({ pr: true, p: [1, 2, 101] }), stroke({ pr: 'oui' }), stroke({ x: 1 }), stroke({ n: 0 }),
    stroke({ p: Array.from({ length: (MAX_PTS + 1) * 2 }, () => 5) }),
  ];
  for (const b of bad) assert.equal(validStroke(b), false, JSON.stringify(b)?.slice(0, 80));
  assert.equal(validStroke(stroke(), { live: true }), false); // un fragment porte son indice de départ
  assert.deepEqual(Object.keys(cleanStroke({ ...stroke(), pr: false })).sort(), ['c', 'id', 'k', 'p', 'w']);
  assert.equal(keepPoint([0, 0], 3, 4, 2, 10), false); assert.equal(keepPoint([0, 0], 30, 40, 2, 10), true);
});

// ---------------- « Vu » ----------------
test('Vu : seul l\'auteur reçoit le nom des lecteurs ; pas d\'accusé pour soi, pour un message inconnu ou d\'un tiers', () => {
  const { hub, store, room, join, say } = setup();
  const a = join('Alice'), b = join('Bruno'), c = join('Chloé');
  say(a, { t: 'chat', text: 'salut' });
  const msg = b.ws.last('chat').msg;
  assert.equal(msg.ark, undefined, 'clé d\'auteur jamais diffusée');
  assert.ok(store.messages(room).find(x => x.id === msg.id).ark);
  say(a, { t: 'seen', ids: [msg.id] }); // soi-même : ignoré
  assert.equal(a.ws.all('seen').length, 0);
  say(b, { t: 'seen', ids: [msg.id, 'ffffffffffffffff', 'pas-un-id', 42] });
  assert.deepEqual(a.ws.last('seen').items, [{ id: msg.id, by: ['Bruno'] }]);
  assert.equal(b.ws.all('seen').length + c.ws.all('seen').length, 0, 'les lecteurs ne reçoivent rien');
  say(b, { t: 'seen', ids: [msg.id] }); assert.equal(a.ws.all('seen').length, 1, 'doublon ignoré');
  say(c, { t: 'seen', ids: [msg.id] });
  assert.deepEqual(a.ws.last('seen').items[0].by, ['Bruno', 'Chloé']);
  // usurpation impossible : le champ « by » ou « from » envoyé par le client est ignoré, le lecteur est la connexion
  say(c, { t: 'seen', ids: [msg.id], by: 'Alice', from: a.p.id });
  assert.deepEqual(a.ws.last('seen').items[0].by, ['Bruno', 'Chloé']);
  // message système : pas d'accusé
  const sys = store.messages(room).find(x => x.kind === 'system');
  say(b, { t: 'seen', ids: [sys.id] }); assert.equal(a.ws.all('seen').length, 2);
  hub.close();
});

test('Vu : reconnexion de l\'auteur → historique marqué « own » et accusés renvoyés ; mémoire bornée et libérée', () => {
  const { hub, room, join, say } = setup();
  const a = join('Alice', 'sess-a'), b = join('Bruno');
  say(a, { t: 'chat', text: 'un' });
  const id = b.ws.last('chat').msg.id;
  say(b, { t: 'seen', ids: [id] });
  a.ws.close();
  const a2 = join('Alice', 'sess-a');
  const w = a2.ws.last('welcome');
  assert.equal(w.history.find(x => x.id === id).own, true);
  assert.ok(w.history.every(x => x.ark === undefined));
  assert.deepEqual(a2.ws.last('seen').items, [{ id, by: ['Bruno'] }]);
  assert.equal(b.ws.last('welcome').history.find(x => x.id === id), undefined); // (Bruno est arrivé avant le message)
  // rafale : au plus 50 ids par envoi, au plus 4 envois par seconde
  const rs = hub.rooms.get(room.id);
  b.p.rates = {};
  for (let i = 0; i < 10; i++) b.ws.emit('message', Buffer.from(JSON.stringify({ t: 'seen', ids: [id] })), false);
  assert.ok(b.p.rates.seen.n > 4);
  assert.ok(rs.seen.size <= 400);
  a2.ws.close(); b.ws.close();
  assert.equal(hub.rooms.get(room.id), undefined, 'salon vide : état (et accusés) libérés');
  hub.close();
});

test('Vu : salon chiffré, l\'accusé ne porte que l\'identifiant opaque', () => {
  const { hub, join, say } = setup({ e2ee: true });
  const a = join('A'), b = join('B');
  say(a, { t: 'chat', enc: 'Q2hpZmZyZQ' });
  const id = b.ws.last('chat').msg.id;
  say(b, { t: 'seen', ids: [id] });
  assert.deepEqual(a.ws.last('seen'), { t: 'seen', items: [{ id, by: ['B'] }] });
  hub.close();
});

// ---------------- tableau blanc ----------------
test('Tableau : ouverture unique, traits relayés et rejoués pour qui arrive, limites', () => {
  const { hub, join, say } = setup();
  const a = join('A'), b = join('B');
  say(a, { t: 'wb', op: 'open' });
  assert.equal(b.ws.last('wb', 'open').board.owner, a.p.id);
  say(b, { t: 'wb', op: 'open' }); assert.equal(b.ws.last('error').code, 'wb');
  const s1 = stroke(), s2 = stroke({ k: 'arrow', c: 2, p: [0, 0, 5000, 3000] });
  say(a, { t: 'wb', op: 'live', s: { ...s1, n: 0 } });
  assert.equal(b.ws.last('wb', 'live').s.id, s1.id); assert.equal(b.ws.last('wb', 'live').from, a.p.id);
  say(a, { t: 'wb', op: 'add', s: s1 }); say(b, { t: 'wb', op: 'add', s: s2 });
  assert.deepEqual(b.ws.last('wb', 'add').s, s1); assert.deepEqual(a.ws.last('wb', 'add').s, s2);
  assert.equal(a.ws.all('wb', 'add').length, 1, 'pas d\'écho à l\'émetteur');
  say(a, { t: 'wb', op: 'add', s: s1 }); assert.equal(b.ws.all('wb', 'add').length, 1, 'identifiant déjà vu refusé');
  say(a, { t: 'wb', op: 'add', s: { ...s1, id: newId(), c: 99 } }); assert.equal(b.ws.all('wb', 'add').length, 1, 'trait invalide refusé');
  // C arrive : état complet rejoué, dans l'ordre
  const c = join('C');
  const st = c.ws.last('wb', 'state');
  assert.deepEqual(st.items.map(x => x.s.id), [s1.id, s2.id]);
  assert.equal(st.board.ownerName, 'A');
  assert.ok(c.ws.json.indexOf(c.ws.last('welcome')) < c.ws.json.indexOf(st), 'état envoyé après l\'accueil');
  hub.close();
});

test('Tableau : annuler ne retire que ses propres traits ; verrou, effacement et fermeture réservés à l\'ouvreur', () => {
  const { hub, room, join, say } = setup();
  const a = join('A'), b = join('B');
  say(a, { t: 'wb', op: 'open' });
  const sa = stroke(), sb = stroke();
  say(a, { t: 'wb', op: 'add', s: sa }); say(b, { t: 'wb', op: 'add', s: sb });
  say(b, { t: 'wb', op: 'undo', ids: [sa.id, sb.id] });
  assert.deepEqual(a.ws.last('wb', 'del').ids, [sb.id]);
  const rs = hub.rooms.get(room.id);
  assert.deepEqual(rs.board.items.map(x => x.id), [sa.id]);
  // B ne peut ni verrouiller, ni effacer, ni fermer
  for (const op of ['lock', 'clear', 'close']) say(b, { t: 'wb', op, on: true });
  assert.ok(rs.board); assert.equal(rs.board.locked, false); assert.equal(rs.board.items.length, 1);
  say(a, { t: 'wb', op: 'lock', on: true });
  assert.equal(b.ws.last('wb', 'meta').board.locked, true);
  const n = a.ws.all('wb').length;
  say(b, { t: 'wb', op: 'add', s: stroke() }); say(b, { t: 'wb', op: 'live', s: { ...stroke(), n: 0 } });
  assert.equal(a.ws.all('wb').length, n, 'verrouillé : B ne dessine plus');
  say(a, { t: 'wb', op: 'add', s: stroke() }); assert.equal(rs.board.items.length, 2, 'l\'ouvreur dessine toujours');
  say(a, { t: 'wb', op: 'clear' }); assert.ok(b.ws.last('wb', 'clear')); assert.equal(rs.board.items.length, 0); assert.equal(rs.board.bytes, 0);
  say(a, { t: 'wb', op: 'close' }); assert.ok(b.ws.last('wb', 'close')); assert.equal(rs.board, null);
  hub.close();
});

test('Tableau : limites de débit, de taille et de nombre de traits', () => {
  const { hub, room, join, say } = setup();
  const a = join('A'), b = join('B');
  say(a, { t: 'wb', op: 'open' });
  a.p.rates = {};
  for (let i = 0; i < LIMITS.rate.add + 15; i++) a.ws.emit('message', Buffer.from(JSON.stringify({ t: 'wb', op: 'add', s: stroke() })), false);
  assert.equal(b.ws.all('wb', 'add').length, LIMITS.rate.add, 'débit limité');
  const rs = hub.rooms.get(room.id);
  rs.board.bytes = LIMITS.bytes - 10;
  say(a, { t: 'wb', op: 'add', s: stroke() });
  assert.equal(a.ws.last('error').code, 'wb-full');
  hub.close();
});

test('Tableau : départ de l\'ouvreur → délai de grâce, reprise s\'il revient, sinon fermeture', () => {
  const { hub, room, join, say } = setup();
  const a = join('A', 'sess-a'), b = join('B');
  say(a, { t: 'wb', op: 'open' });
  say(a, { t: 'wb', op: 'add', s: stroke() });
  a.ws.close();
  assert.equal(b.ws.last('wb', 'meta').board.away, true);
  const rs = hub.rooms.get(room.id);
  const a2 = join('A', 'sess-a');
  assert.equal(rs.board.owner, a2.p.id);
  assert.equal(a2.ws.last('wb', 'state').board.owner, a2.p.id);
  assert.equal(a2.ws.last('wb', 'state').items.length, 1);
  a2.ws.close();
  rs.board.orphanUntil = Date.now() - 1; hub.tick();
  assert.equal(rs.board, null); assert.ok(b.ws.last('wb', 'close'));
  hub.close();
});

test('Tableau : salon chiffré, traits opaques uniquement (texte clair refusé)', () => {
  const { hub, room, join, say } = setup({ e2ee: true });
  const a = join('A'), b = join('B');
  say(a, { t: 'wb', op: 'open' });
  const id = newId();
  say(a, { t: 'wb', op: 'add', s: stroke() });
  assert.equal(b.ws.all('wb', 'add').length, 0, 'trait en clair refusé dans un salon chiffré');
  say(a, { t: 'wb', op: 'add', id, enc: 'pas du base64 !' }); assert.equal(b.ws.all('wb', 'add').length, 0);
  say(a, { t: 'wb', op: 'add', id: 'X', enc: 'Q2hpZmZyZQ' }); assert.equal(b.ws.all('wb', 'add').length, 0);
  say(a, { t: 'wb', op: 'add', id, enc: 'Q2hpZmZyZQ' });
  assert.deepEqual(b.ws.last('wb', 'add'), { t: 'wb', op: 'add', id, from: a.p.id, enc: 'Q2hpZmZyZQ' });
  say(a, { t: 'wb', op: 'live', id: newId(), n: 4, enc: 'TGl2ZQ' });
  assert.equal(b.ws.last('wb', 'live').enc, 'TGl2ZQ');
  const c = join('C');
  assert.deepEqual(c.ws.last('wb', 'state').items, [{ id, from: a.p.id, enc: 'Q2hpZmZyZQ' }]);
  assert.equal(hub.rooms.get(room.id).board.items[0].pub.s, undefined);
  hub.close();
});
