// 1.12 : suppression automatique des salons PUBLICS restés vides (minuteurs simulés).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Hub } from '../../server/hub.mjs';
import { Store } from '../../server/store.mjs';
import { RoomReaper } from '../../server/reaper.mjs';
import { loadConfig } from '../../server/config.mjs';

const MIN = 60e3;
class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.json = []; this.closed = null; }
  send(d) { if (typeof d === 'string') this.json.push(JSON.parse(d)); }
  close(code) { if (this.readyState === 3) return; this.closed = code; this.readyState = 3; this.emit('close'); }
}
// Horloge et minuteurs simulés, injectés dans le RoomReaper (aucune attente réelle).
function fakeClock(start = 1_700_000_000_000) {
  let now = start, seq = 0; const q = new Map();
  return {
    now: () => now,
    timers: { set: (fn, ms) => { const id = ++seq; q.set(id, { fn, at: now + Math.max(0, ms) }); return id; }, clear: id => q.delete(id) },
    pending: () => q.size,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null; for (const [id, t] of q) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        q.delete(next[0]); now = next[1].at; next[1].fn();
      }
      now = end;
    },
  };
}
function setup({ dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-reaper-')), ttlMin = 10, clock = fakeClock(), start = true } = {}) {
  const store = new Store(dir);
  const hub = new Hub({ store, cfg: loadConfig({ quiet: true }) });
  const destroyed = [];
  const reaper = new RoomReaper({ store, count: r => hub.count(r), ttlMs: () => ttlMin * MIN, now: clock.now, timers: clock.timers, onDestroy: r => destroyed.push(r.slug) });
  hub.onOccupied = r => reaper.occupied(r); hub.onEmpty = r => reaper.emptied(r);
  if (start) reaper.start();
  const join = (room, name = 'A') => { const ws = new FakeWs(); const p = hub.attach(ws, { room, name, sessionId: name });
    if (p) ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', name, caps: {}, state: {} })), false); return { ws, p }; };
  return { dir, store, hub, reaper, clock, destroyed, join, done: () => { reaper.close(); hub.close(); } };
}

test('salon public vidé : supprimé après 10 min, tout son état effacé, nom de nouveau libre', () => {
  const { dir, store, hub, reaper, clock, destroyed, join, done } = setup();
  const room = store.createRoom({ name: 'Apéro public', isPublic: true });
  const a = join(room, 'Alice');
  hub.onControl(a.p, JSON.stringify({ t: 'chat', text: 'bonjour' }));
  const f = store.saveFile(room, { name: 'a.txt', type: 'text/plain', data: Buffer.from('x') });
  assert.ok(fs.existsSync(path.join(dir, 'messages', `${room.id}.jsonl`)));
  assert.equal(reaper.timers.size, 0, 'occupé : aucun minuteur');
  a.ws.close(1000);
  assert.equal(hub.rooms.size, 0, 'état mémoire du salon (tableau, « Vu ») libéré dès qu\'il est vide');
  assert.equal(reaper.timers.size, 1);
  assert.equal(reaper.remaining(room), 10 * MIN);
  clock.advance(10 * MIN - 1000);
  assert.ok(store.getRoom(room.slug), 'encore là à 9 min 59 s');
  assert.equal(Math.ceil(reaper.remaining(room) / 1000), 1);
  clock.advance(1000);
  assert.equal(store.getRoom(room.slug), null);
  assert.deepEqual(destroyed, [room.slug]);
  assert.ok(!fs.existsSync(path.join(dir, 'messages', `${room.id}.jsonl`)), 'historique effacé');
  assert.equal(store.fileMeta(f.id), null); assert.ok(!fs.existsSync(store.filePath(f.id)), 'pièce jointe effacée');
  assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8')).some(r => r.id === room.id), 'retiré de rooms.json');
  assert.equal(store.publicRooms().length, 0);
  assert.equal(reaper.timers.size, 0, 'pas de minuteur restant');
  const again = store.createRoom({ name: 'Apéro public', isPublic: true });
  assert.equal(again.slug, room.slug); assert.notEqual(again.id, room.id);
  assert.equal(store.messages(again).length, 0, 'le nouveau salon repart vide');
  done();
});

test('retour avant 10 min : salon conservé, le compte à rebours repart de zéro au départ suivant', () => {
  const { store, reaper, clock, join, done } = setup();
  const room = store.createRoom({ name: 'Club', isPublic: true });
  join(room).ws.close();
  clock.advance(9 * MIN);
  const b = join(room, 'Bob');
  assert.equal(reaper.timers.size, 0); assert.equal(room.emptySince, undefined);
  clock.advance(60 * MIN);
  assert.ok(store.getRoom('club'), 'occupé : jamais supprimé');
  b.ws.close();
  clock.advance(9 * MIN); assert.ok(store.getRoom('club'), 'nouveau délai complet');
  clock.advance(MIN); assert.equal(store.getRoom('club'), null);
  done();
});

test('salon public créé mais jamais rejoint : supprimé aussi après le délai', () => {
  const { store, reaper, clock, done } = setup();
  const room = store.createRoom({ name: 'Fantôme', isPublic: true });
  reaper.emptied(room); // fait par POST /api/rooms
  clock.advance(10 * MIN); assert.equal(store.getRoom(room.slug), null);
  done();
});

test('salons privés et salons protégés par mot de passe : non concernés', () => {
  const { store, reaper, clock, join, done } = setup();
  const priv = store.createRoom({ name: 'Famille' });
  const pw = store.createRoom({ name: 'Public à mot de passe', isPublic: true, passwordHash: 'x' });
  for (const r of [priv, pw]) { reaper.emptied(r); join(r).ws.close(); }
  assert.equal(reaper.timers.size, 0);
  assert.equal(reaper.remaining(priv), null); assert.equal(reaper.remaining(pw), null);
  clock.advance(24 * 60 * MIN);
  assert.ok(store.getRoom(priv.slug)); assert.ok(store.getRoom(pw.slug));
  done();
});

test('plusieurs départs / arrivées : un seul minuteur par salon, aucun après fermeture', () => {
  const { store, reaper, clock, join, done } = setup();
  const rooms = ['un', 'deux', 'trois'].map(n => store.createRoom({ name: n, isPublic: true }));
  for (let i = 0; i < 50; i++) for (const r of rooms) { const a = join(r), b = join(r, 'B'); a.ws.close(); b.ws.close(); reaper.emptied(r); }
  assert.equal(reaper.timers.size, 3); assert.equal(clock.pending(), 3);
  reaper.close();
  assert.equal(reaper.timers.size, 0); assert.equal(clock.pending(), 0);
  clock.advance(60 * MIN); assert.equal(store.rooms.size, 3, 'arrêt du service : rien supprimé');
  done();
});

test('course : arrivée en cours (bump), salon supprimé pendant la poignée de main, déclenchement avec quelqu\'un', () => {
  const { store, hub, reaper, clock, join, done } = setup();
  const room = store.createRoom({ name: 'Course', isPublic: true });
  join(room).ws.close();
  clock.advance(9 * MIN + 59e3);
  reaper.bump(room); // poignée de main WebSocket en cours
  clock.advance(2 * MIN); assert.ok(store.getRoom('course'), 'bump : délai relancé');
  // déclenchement alors que quelqu'un est là (ex. minuteur en retard) : rien n'est supprimé
  const c = join(room, 'C'); reaper.fire(room.id, room.slug); assert.ok(store.getRoom('course'));
  c.ws.close();
  clock.advance(10 * MIN); assert.equal(store.getRoom('course'), null);
  // connexion qui aboutit après la suppression : refusée, aucun état recréé, aucun fichier réécrit
  const ws = new FakeWs(); assert.equal(hub.attach(ws, { room, name: 'Tard', sessionId: 't' }), null);
  assert.equal(ws.closed, 4005); assert.equal(hub.rooms.size, 0);
  assert.equal(hub.postAi(room, 'résumé'), null);
  assert.throws(() => store.saveFile(room, { name: 'a', type: 'text/plain', data: Buffer.from('x') }), /n'existe plus/);
  assert.ok(!fs.existsSync(path.join(store.msgDir, `${room.id}.jsonl`)));
  done();
});

test('fermeture par l\'admin d\'un salon public occupé : compte à rebours lancé', () => {
  const { store, hub, reaper, clock, join, done } = setup();
  const room = store.createRoom({ name: 'Fermé', isPublic: true });
  join(room); join(room, 'B');
  hub.closeRoom(room.id);
  assert.equal(reaper.timers.size, 1);
  clock.advance(10 * MIN); assert.equal(store.getRoom(room.slug), null);
  done();
});

test('redémarrage : délai conservé, salon déjà expiré supprimé tout de suite, date inconnue → délai complet', () => {
  const clock = fakeClock();
  const first = setup({ clock });
  const keep = first.store.createRoom({ name: 'Garde', isPublic: true });
  const old = first.store.createRoom({ name: 'Vieux', isPublic: true });
  const unknown = first.store.createRoom({ name: 'Inconnu', isPublic: true });
  const priv = first.store.createRoom({ name: 'Privé' });
  first.join(old).ws.close();
  clock.advance(4 * MIN);
  first.join(keep).ws.close();
  first.join(unknown); // occupé au moment de la panne : pas de date de vide enregistrée
  first.store.saveNow(); first.done.call(null); // arrêt (le minuteur est annulé, rien n'est supprimé)
  assert.equal(JSON.parse(fs.readFileSync(path.join(first.dir, 'rooms.json'), 'utf8')).find(r => r.slug === 'garde').emptySince, clock.now());
  clock.advance(7 * MIN); // service arrêté 7 min : « vieux » est vide depuis 11 min, « garde » depuis 7 min
  const second = setup({ dir: first.dir, clock });
  clock.advance(0);
  assert.equal(second.store.getRoom('vieux'), null, 'expiré pendant l\'arrêt : supprimé au démarrage');
  assert.ok(second.store.getRoom('garde'));
  clock.advance(3 * MIN - 1000); assert.ok(second.store.getRoom('garde'));
  clock.advance(1000); assert.equal(second.store.getRoom('garde'), null, 'reste du délai seulement');
  assert.ok(second.store.getRoom('inconnu'));
  clock.advance(7 * MIN - 1000); assert.ok(second.store.getRoom('inconnu'));
  clock.advance(1000); assert.equal(second.store.getRoom('inconnu'), null, 'date inconnue : 10 min après le démarrage');
  assert.ok(second.store.getRoom(priv.slug), 'privé intact');
  second.done();
});

test('délai 0 : suppression automatique désactivée ; délai configurable par PUBLIC_ROOM_IDLE_TTL_MIN', () => {
  const { store, reaper, clock, join, done } = setup({ ttlMin: 0 });
  const room = store.createRoom({ name: 'Éternel', isPublic: true });
  join(room).ws.close();
  assert.equal(reaper.timers.size, 0); assert.equal(reaper.remaining(room), null);
  clock.advance(1e9); assert.ok(store.getRoom(room.slug));
  done();
  const env = process.env.PUBLIC_ROOM_IDLE_TTL_MIN;
  try {
    delete process.env.PUBLIC_ROOM_IDLE_TTL_MIN; assert.equal(loadConfig().publicRoomIdleTtlMin, 10);
    process.env.PUBLIC_ROOM_IDLE_TTL_MIN = '3'; assert.equal(loadConfig().publicRoomIdleTtlMin, 3);
    process.env.PUBLIC_ROOM_IDLE_TTL_MIN = '0.05'; assert.equal(loadConfig().publicRoomIdleTtlMin, 0.05);
    process.env.PUBLIC_ROOM_IDLE_TTL_MIN = '0'; assert.equal(loadConfig().publicRoomIdleTtlMin, 0);
    process.env.PUBLIC_ROOM_IDLE_TTL_MIN = 'abc'; assert.equal(loadConfig().publicRoomIdleTtlMin, 10);
    process.env.PUBLIC_ROOM_IDLE_TTL_MIN = '-4'; assert.equal(loadConfig().publicRoomIdleTtlMin, 10);
  } finally { if (env === undefined) delete process.env.PUBLIC_ROOM_IDLE_TTL_MIN; else process.env.PUBLIC_ROOM_IDLE_TTL_MIN = env; }
});
