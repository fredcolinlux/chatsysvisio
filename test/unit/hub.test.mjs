import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Hub, VIDEO_HIGH_WATER } from '../../server/hub.mjs';
import { Store } from '../../server/store.mjs';
import { loadConfig } from '../../server/config.mjs';
import { pack, unpack, T_VIDEO, T_AUDIO, F_KEY, CODECS } from '../../public/js/protocol.js';

class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.json = []; this.bin = []; this.closed = null; }
  send(d) { if (typeof d === 'string') this.json.push(JSON.parse(d)); else this.bin.push(unpack(new Uint8Array(d))); }
  close(code) { this.closed = code; this.readyState = 3; this.emit('close'); }
  last(t) { return this.json.filter(m => m.t === t).at(-1); }
}
function setup(over = {}) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hub-')));
  const hub = new Hub({ store, cfg: loadConfig({ quiet: true, ...over }) });
  const room = store.createRoom({ name: 'Hub test', isPublic: true });
  const join = (name, caps = { venc: ['vp8'], vdec: ['vp8'], aenc: ['opus'], adec: ['opus'] }) => {
    const ws = new FakeWs(); const p = hub.attach(ws, { room, name, sessionId: name });
    if (p) ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', name, caps, state: { mic: true, cam: true } })), false);
    return { ws, p };
  };
  return { hub, room, join };
}
const vid = (layer, key = true) => Buffer.from(pack({ type: T_VIDEO, layer, flags: key ? F_KEY : 0, codec: CODECS.vp8 }, new Uint8Array(100)));
const aud = level => Buffer.from(pack({ type: T_AUDIO, codec: CODECS.opus, level }, new Uint8Array(40)));

test('codec : VP8 si tout le monde sait le décoder, sinon repli JPEG/ADPCM', () => {
  const { hub, join } = setup();
  const a = join('A'); join('B');
  assert.deepEqual(a.ws.last('codec'), { t: 'codec', video: 'vp8', audio: 'opus' });
  join('Vieux', { venc: [], vdec: [], aenc: [], adec: [] });
  assert.deepEqual(a.ws.last('codec'), { t: 'codec', video: 'jpeg', audio: 'adpcm' });
  hub.close();
});

test('vidéo : transmise seulement aux abonnés, besoin de couches signalé à l\'émetteur', () => {
  const { hub, join } = setup();
  const a = join('A'), b = join('B'), c = join('C');
  b.ws.emit('message', Buffer.from(JSON.stringify({ t: 'subs', want: [[a.p.sid, 1]] })), false);
  assert.deepEqual(a.ws.last('need').layers, [1]);
  a.ws.emit('message', vid(1), true); a.ws.emit('message', vid(0), true);
  assert.equal(b.ws.bin.length, 1); assert.equal(b.ws.bin[0].sid, a.p.sid); assert.equal(b.ws.bin[0].layer, 1);
  assert.equal(c.ws.bin.length, 0);
  hub.close();
});

test('vidéo : nouvel abonné attend une image clé', () => {
  const { hub, join } = setup();
  const a = join('A'), b = join('B');
  b.ws.emit('message', Buffer.from(JSON.stringify({ t: 'subs', want: [[a.p.sid, 0]] })), false);
  assert.ok(a.ws.json.some(m => m.t === 'keyreq'));
  a.ws.emit('message', vid(0, false), true); assert.equal(b.ws.bin.length, 0);
  a.ws.emit('message', vid(0, true), true); a.ws.emit('message', vid(0, false), true); assert.equal(b.ws.bin.length, 2);
  hub.close();
});

test('contre-pression : destinataire saturé → images abandonnées puis passage en basse définition', () => {
  const { hub, join } = setup();
  const a = join('A'), b = join('B');
  b.ws.emit('message', Buffer.from(JSON.stringify({ t: 'subs', want: [[a.p.sid, 1]] })), false);
  b.ws.bufferedAmount = VIDEO_HIGH_WATER + 1;
  for (let i = 0; i < 12; i++) a.ws.emit('message', vid(1), true);
  assert.equal(b.ws.bin.length, 0);
  assert.equal(b.ws.last('quality').level, 'low');
  assert.deepEqual(a.ws.last('need').layers, [0]); // l'émetteur n'envoie plus que la basse définition
  b.ws.bufferedAmount = 0; a.ws.emit('message', vid(0), true);
  assert.equal(b.ws.bin.at(-1).layer, 0);
  hub.close();
});

test('audio : seuls les N plus forts sont relayés', () => {
  const { hub, join } = setup({ audioTopN: 2 });
  const ps = ['A', 'B', 'C', 'D'].map(n => join(n));
  ps.forEach((x, i) => x.ws.emit('message', aud(100 + i * 40), true));
  hub.tick();
  const lis = ps[0];
  lis.ws.bin.length = 0;
  ps.forEach((x, i) => x.ws.emit('message', aud(100 + i * 40), true));
  const sids = new Set(lis.ws.bin.map(p => p.sid));
  assert.deepEqual([...sids].sort(), [ps[2].p.sid, ps[3].p.sid].sort());
  hub.close();
});

test('limite : 25 personnes maximum par salon', () => {
  const { hub, room, join } = setup();
  const all = Array.from({ length: 25 }, (_, i) => join('P' + i));
  assert.ok(all.every(x => x.p));
  assert.equal(hub.count(room), 25);
  const extra = join('Trop');
  assert.equal(extra.p, null); assert.equal(extra.ws.closed, 4003);
  hub.close();
});

test('chat : texte borné, réponse, réactions limitées à la liste', () => {
  const { hub, join } = setup();
  const a = join('A'), b = join('B');
  a.ws.emit('message', Buffer.from(JSON.stringify({ t: 'chat', text: 'x'.repeat(5000) })), false);
  const m = b.ws.last('chat').msg; assert.equal(m.text.length, 4000);
  b.ws.emit('message', Buffer.from(JSON.stringify({ t: 'chat', text: 'ok', replyTo: m.id })), false);
  assert.equal(a.ws.last('chat').msg.replyTo.name, 'A');
  a.ws.emit('message', Buffer.from(JSON.stringify({ t: 'msgreact', id: m.id, emoji: '<script>' })), false);
  assert.equal(a.ws.last('msgreact'), undefined);
  a.ws.emit('message', Buffer.from(JSON.stringify({ t: 'msgreact', id: m.id, emoji: '👍' })), false);
  assert.deepEqual(b.ws.last('msgreact').reactions, { '👍': ['A'] });
  hub.close();
});

// ---- Chiffrement de bout en bout (salon privé) ----
function setupE2ee(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hub-e2ee-'));
  const store = new Store(dir);
  const hub = new Hub({ store, cfg: loadConfig({ quiet: true, ...over }) });
  const room = store.createRoom({ name: 'Secret', isPublic: false, e2ee: { v: 1, mode: 'link', salt: 'A'.repeat(22), iter: 600000, kcv: 'B'.repeat(22) } });
  const join = (name, extra = { proto: 2 }) => {
    const ws = new FakeWs(); const p = hub.attach(ws, { room, name, sessionId: name });
    ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', name, caps: { venc: ['vp8'], vdec: ['vp8'], aenc: ['opus'], adec: ['opus'] }, state: {}, ...extra })), false);
    return { ws, p };
  };
  const say = (who, m) => who.ws.emit('message', Buffer.from(JSON.stringify(m)), false);
  return { hub, store, room, join, say, dir };
}

test('E2EE : texte en clair refusé, message chiffré stocké tel quel, assistant désactivé', () => {
  const { hub, store, room, join, say, dir } = setupE2ee({ aiEnabled: true });
  const a = join('A'), b = join('B');
  assert.equal(a.ws.last('welcome').room.e2ee, 'link'); assert.equal(a.ws.last('welcome').ai, false);
  const userMsgs = () => b.ws.json.filter(m => m.t === 'chat' && m.msg.kind !== 'system');
  say(a, { t: 'chat', text: 'bonjour en clair' });
  assert.equal(a.ws.last('error').code, 'e2ee'); assert.equal(userMsgs().length, 0);
  say(a, { t: 'chat', enc: 'Zm9vYmFy', fileId: 'x' }); assert.equal(userMsgs().length, 0);
  say(a, { t: 'chat', enc: 'pas du base64url !' }); assert.equal(userMsgs().length, 0);
  say(a, { t: 'chat', enc: 'Q2hpZmZyZQ' });
  const m = b.ws.last('chat').msg; assert.equal(m.enc, 'Q2hpZmZyZQ'); assert.equal(m.text, undefined);
  const disk = fs.readFileSync(path.join(dir, 'messages', room.id + '.jsonl'), 'utf8');
  assert.ok(disk.includes('Q2hpZmZyZQ')); assert.ok(!disk.includes('bonjour'));
  assert.equal(store.messages(room).filter(x => x.kind !== 'system').length, 1);
  hub.close();
});

test('E2EE : réactions opaques, une par personne, sans identifiant interne', () => {
  const { hub, join, say } = setupE2ee();
  const a = join('A'), b = join('B');
  say(a, { t: 'chat', enc: 'TXNn' }); const id = b.ws.json.filter(m => m.t === 'chat' && m.msg.enc).at(-1).msg.id;
  say(b, { t: 'msgreact', id, enc: 'UjE' }); say(b, { t: 'msgreact', id, enc: 'UjI' }); say(a, { t: 'msgreact', id, enc: 'UjM' });
  const r = a.ws.last('msgreact'); assert.deepEqual(r.erx.sort(), ['UjI', 'UjM']); assert.equal(r.reactions, undefined);
  say(a, { t: 'msgreact', id, emoji: '👍' }); assert.deepEqual(a.ws.last('msgreact').erx.sort(), ['UjI', 'UjM']);
  // à la reconnexion, l'historique ne révèle pas les clés internes
  const c = join('C'); const h = c.ws.last('welcome').history.find(x => x.id === id);
  assert.ok(Array.isArray(h.erx)); assert.equal(h.rx, undefined);
  hub.close();
});

test('E2EE : annonces relayées, clé emballée remise au seul destinataire, demandes de clé limitées', () => {
  const { hub, join, say } = setupE2ee();
  const a = join('A'), b = join('B'), c = join('C');
  const ann = { pub: 'P'.repeat(87), nonce: 'N'.repeat(22), mac: 'M'.repeat(43) };
  say(a, { t: 'e2ee', op: 'ann', ann });
  assert.deepEqual(b.ws.last('e2ee').ann, ann); assert.equal(b.ws.last('e2ee').from, a.p.id);
  const d = join('D'); assert.deepEqual(d.ws.last('welcome').peers.find(x => x.id === a.p.id).ann, ann);
  say(a, { t: 'e2ee', op: 'key', to: b.p.id, w: 'V3JhcA' });
  assert.equal(b.ws.last('e2ee').w, 'V3JhcA'); assert.equal(c.ws.json.filter(m => m.t === 'e2ee' && m.op === 'key').length, 0);
  say(a, { t: 'e2ee', op: 'key', to: b.p.id, w: 'x'.repeat(2001) }); assert.equal(b.ws.json.filter(m => m.op === 'key').length, 1);
  say(a, { t: 'e2ee', op: 'keyreq', tag: 7 }); say(a, { t: 'e2ee', op: 'keyreq', tag: 7 });
  assert.equal(b.ws.json.filter(m => m.op === 'keyreq').length, 1);
  hub.close();
});

test('salon public : jamais d\'E2EE côté serveur, messages en clair acceptés', () => {
  const { hub, join } = setup();
  const a = join('A'), b = join('B');
  assert.equal(a.ws.last('welcome').room.e2ee, null);
  a.ws.emit('message', Buffer.from(JSON.stringify({ t: 'e2ee', op: 'ann', ann: { pub: 'P', nonce: 'N', mac: 'M' } })), false);
  assert.equal(b.ws.last('e2ee'), undefined);
  a.ws.emit('message', Buffer.from(JSON.stringify({ t: 'chat', text: 'bonjour' })), false);
  assert.equal(b.ws.last('chat').msg.text, 'bonjour');
  hub.close();
});

test('version : client ancien (sans protocole) refusé clairement dans un salon chiffré, accepté en salon public', () => {
  const { hub, join } = setupE2ee();
  const old = join('Ancien', {});
  assert.equal(old.ws.last('error').code, 'version'); assert.match(old.ws.last('error').message, /Ctrl\+F5/);
  assert.equal(old.ws.closed, 1008); assert.equal(old.ws.last('welcome'), undefined);
  hub.close();
  const pub = setup(); const a = pub.join('Ancien public');
  assert.ok(a.ws.last('welcome')); assert.equal(a.ws.closed, null);
  pub.hub.close();
});

test('version : client d\'un autre build invité à recharger (4010), même build accepté', () => {
  const { hub, join } = setupE2ee({ });
  hub.cfg.build = '8';
  const a = join('Périmé', { proto: 2, build: '7' });
  assert.equal(a.ws.closed, 4010); assert.equal(a.ws.last('error').build, '8');
  const b = join('À jour', { proto: 2, build: '8' });
  assert.equal(b.ws.closed, null); assert.equal(b.ws.last('welcome').server.build, '8');
  hub.close();
});

test('E2EE : aucun média relayé avant l\'annonce de clé de l\'émetteur', () => {
  const { hub, join, say } = setupE2ee();
  const a = join('A', { proto: 2, state: { mic: true } }), b = join('B');
  a.ws.emit('message', aud(200), true); assert.equal(b.ws.bin.length, 0);
  say(a, { t: 'e2ee', op: 'ann', ann: { pub: 'P'.repeat(87), nonce: 'N'.repeat(22), mac: 'M'.repeat(43) } });
  a.ws.emit('message', aud(200), true); assert.equal(b.ws.bin.length, 1);
  hub.close();
});
