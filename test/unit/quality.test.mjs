// HD 1080p (1.1.0) : réglage, plafonds, choix de couche, adaptation, repli relais, limites serveur.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { EventEmitter } from 'node:events';
import { normalizeQuality, ceilingFor, clampToSource, hdParams, screenParams, pickLayer, SendAdapter, degradeLayer } from '../../public/js/quality.js';
import { pack, unpack, T_VIDEO, F_KEY, CODECS, L_LO, L_HI, L_SCREEN, L_HD } from '../../public/js/protocol.js';
import { Hub, MAX_MEDIA_MESSAGE } from '../../server/hub.mjs';
import { Store } from '../../server/store.mjs';
import { loadConfig } from '../../server/config.mjs';

test('réglage mémorisé : ancien « hd » → 720p, valeur inconnue → auto', () => {
  assert.equal(normalizeQuality('hd'), '720p');
  assert.equal(normalizeQuality('1080p'), '1080p');
  assert.equal(normalizeQuality('<script>'), 'auto');
  assert.equal(normalizeQuality(null), 'auto');
});

test('plafond : auto = 1080p sur ordinateur, 720p sur mobile ; repli encodeur, JPEG, flou mobile, serveur', () => {
  assert.equal(ceilingFor('auto', { codec: 'vp8', deviceMax: 1080 }), 1080);
  assert.equal(ceilingFor('auto', { mobile: true, codec: 'vp8', deviceMax: 1080 }), 720);
  assert.equal(ceilingFor('1080p', { mobile: true, codec: 'avc', deviceMax: 1080 }), 1080);
  assert.equal(ceilingFor('1080p', { mobile: true, effects: true, codec: 'avc', deviceMax: 1080 }), 720);
  assert.equal(ceilingFor('1080p', { effects: true, codec: 'vp8', deviceMax: 1080 }), 1080); // ordinateur : flou en 1080p
  assert.equal(ceilingFor('1080p', { codec: 'vp8', deviceMax: 720 }), 720);               // isConfigSupported refuse la 1080p
  assert.equal(ceilingFor('1080p', { codec: 'jpeg', deviceMax: 1080 }), 360);
  assert.equal(ceilingFor('1080p', { codec: 'vp8', deviceMax: 1080, serverMax: 720 }), 720);
  assert.equal(ceilingFor('360p', { codec: 'vp8' }), 360);
  assert.equal(ceilingFor('eco', { codec: 'vp8' }), 144);
});

test('plafond limité par la vraie caméra', () => {
  assert.equal(clampToSource(1080, 1920, 1080), 1080);
  assert.equal(clampToSource(1080, 1080, 1920), 1080);   // téléphone en portrait
  assert.equal(clampToSource(1080, 1280, 720), 720);
  assert.equal(clampToSource(1080, 640, 480), 360);
  assert.equal(clampToSource(720, 1920, 1080), 720);
});

test('paramètres d\'encodage : 1080p ≈ 2,5 Mbit/s à 24 i/s, 720p ≈ 1,2 Mbit/s', () => {
  assert.deepEqual(hdParams(1080), { maxW: 1920, maxH: 1080, kbps: 2500, fps: 24, quality: 0.75 });
  assert.equal(hdParams(720).maxH, 720); assert.equal(hdParams(720).kbps, 1200);
  assert.equal(hdParams(360, { hi: 450 }).kbps, 450);
  assert.equal(hdParams(1080, { hd1080: 3000 }).kbps, 3000);
});

test('partage d\'écran : 1080p en auto/1080p, 720p sinon ou pendant une adaptation', () => {
  assert.equal(screenParams('auto', { codec: 'vp8' }).maxH, 1080);
  assert.equal(screenParams('1080p', { codec: 'vp8' }).kbps, 1500);
  assert.equal(screenParams('720p', { codec: 'vp8' }).maxH, 720);
  assert.equal(screenParams('auto', { codec: 'vp8', adaptLevel: 1 }).maxH, 720);
  assert.equal(screenParams('auto', { codec: 'jpeg' }).maxH, 720);
});

test('couche demandée : vignettes en basse déf, HD seulement en grand et si l\'émetteur la propose', () => {
  assert.equal(pickLayer({ big: false, w: 1920, h: 1080, vq: 1080 }), L_LO);
  assert.equal(pickLayer({ big: true, w: 1100, h: 700, vq: 1080 }), L_HD);       // 1 à 1 sur ordinateur
  assert.equal(pickLayer({ big: true, w: 1100, h: 700, vq: 360 }), L_HI);        // émetteur en 360p
  assert.equal(pickLayer({ big: true, w: 1100, h: 700, vq: 144 }), L_LO);        // émetteur en Économie
  assert.equal(pickLayer({ big: true, w: 420, h: 260, dpr: 1, vq: 1080 }), L_HI); // petite tuile : 360p suffit
  assert.equal(pickLayer({ big: true, w: 420, h: 260, dpr: 2, vq: 1080 }), L_HD); // écran Retina
  assert.equal(pickLayer({ big: true, w: 1100, h: 700, vq: 1080, noHd: true }), L_HI);
});

test('adaptation émetteur : 1080p → 720p → 360p si la socket accumule, remontée après 20 s', () => {
  const a = new SendAdapter(); let t = 0;
  assert.equal(a.update({ ceiling: 1080, buffered: 0, now: t }), 1080);
  assert.equal(a.update({ ceiling: 1080, buffered: 500_000, now: t += 250 }), 1080);
  assert.equal(a.update({ ceiling: 1080, buffered: 500_000, now: t += 1000 }), 720);
  assert.equal(a.update({ ceiling: 1080, lagging: true, now: t += 1000 }), 360);   // encodeur en retard
  assert.equal(a.update({ ceiling: 1080, lagging: true, now: t += 5000 }), 360);   // plancher
  assert.equal(a.update({ ceiling: 1080, now: t += 1000 }), 360);
  assert.equal(a.update({ ceiling: 1080, now: t += 20000 }), 720);
  assert.equal(a.update({ ceiling: 1080, now: t += 20000 }), 1080);
  const b = new SendAdapter(); assert.equal(b.update({ ceiling: 720, buffered: 1e6, now: 0 }), 720);
  assert.equal(b.update({ ceiling: 720, buffered: 1e6, now: 1500 }), 360);
});

test('repli relais : HD → 360p au premier cran, vignettes au second ; écran jamais remplacé', () => {
  assert.equal(degradeLayer(L_HD, 0), L_HD);
  assert.equal(degradeLayer(L_HD, 1), L_HI); assert.equal(degradeLayer(L_HI, 1), L_LO);
  assert.equal(degradeLayer(L_HD, 2), L_LO); assert.equal(degradeLayer(L_SCREEN, 2), L_SCREEN);
});

// ---- Relais ----
class FakeWs extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.json = []; this.bin = []; }
  send(d) { if (typeof d === 'string') this.json.push(JSON.parse(d)); else this.bin.push(unpack(new Uint8Array(d))); }
  close() { this.readyState = 3; this.emit('close'); }
  last(t) { return this.json.filter(m => m.t === t).at(-1); }
}
function setup(over = {}) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-hd-')));
  const hub = new Hub({ store, cfg: loadConfig({ quiet: true, ...over }) });
  const room = store.createRoom({ name: 'HD', isPublic: true });
  const join = name => {
    const ws = new FakeWs(); const p = hub.attach(ws, { room, name, sessionId: name });
    ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', name, caps: { venc: ['vp8'], vdec: ['vp8'], aenc: ['opus'], adec: ['opus'] }, state: { mic: true, cam: true } })), false);
    return { ws, p };
  };
  const ctl = (x, o) => x.ws.emit('message', Buffer.from(JSON.stringify(o)), false);
  return { hub, join, ctl };
}
const vid = (layer, size = 100, key = true) => Buffer.from(pack({ type: T_VIDEO, layer, flags: key ? F_KEY : 0, codec: CODECS.vp8 }, new Uint8Array(size)));

test('relais : la couche HD (3) ne part qu\'à ceux qui l\'ont demandée', () => {
  const { hub, join, ctl } = setup();
  const a = join('A'), b = join('B'), c = join('C');
  ctl(b, { t: 'subs', want: [[a.p.sid, L_HD]] }); ctl(c, { t: 'subs', want: [[a.p.sid, L_LO]] });
  assert.deepEqual(a.ws.last('need').layers, [L_LO, L_HD]);
  a.ws.emit('message', vid(L_HD), true); a.ws.emit('message', vid(L_LO), true); a.ws.emit('message', vid(L_HI), true);
  assert.deepEqual(b.ws.bin.map(p => p.layer), [L_HD]);
  assert.deepEqual(c.ws.bin.map(p => p.layer), [L_LO]);
  hub.close();
});

test('relais : une image clé 1080p (600 Ko) passe, au-delà de la limite elle est refusée', () => {
  const { hub, join, ctl } = setup();
  const a = join('A'), b = join('B');
  ctl(b, { t: 'subs', want: [[a.p.sid, L_HD]] });
  a.ws.emit('message', vid(L_HD, 600_000), true);
  assert.equal(b.ws.bin.length, 1); assert.equal(b.ws.bin[0].payload.length, 600_000);
  a.ws.emit('message', vid(L_HD, MAX_MEDIA_MESSAGE), true);
  assert.equal(b.ws.bin.length, 1);
  hub.close();
});

test('relais : débit 1080p normal accepté, inondation bornée (MEDIA_MAX_KBPS)', () => {
  const { hub, join, ctl } = setup({ mediaMaxKbps: 4000 }); // 500 Ko/s, rafale 1,5 Mo
  const a = join('A'), b = join('B');
  ctl(b, { t: 'subs', want: [[a.p.sid, L_HD]] });
  for (let i = 0; i < 10; i++) a.ws.emit('message', vid(L_HD, 100_000), true); // 1 Mo d'un coup : dans la rafale
  assert.equal(b.ws.bin.length, 10);
  for (let i = 0; i < 20; i++) a.ws.emit('message', vid(L_HD, 100_000), true); // 2 Mo de plus : coupé
  assert.ok(b.ws.bin.length < 20, `relayés : ${b.ws.bin.length}`);
  hub.close();
});

test('relais : destinataire saturé → HD remplacée par 360p, puis vignettes ; remontée progressive', () => {
  const { hub, join, ctl } = setup();
  const a = join('A'), b = join('B');
  ctl(b, { t: 'subs', want: [[a.p.sid, L_HD]] });
  b.ws.bufferedAmount = 10e6;
  for (let i = 0; i < 12; i++) a.ws.emit('message', vid(L_HD), true);
  assert.deepEqual(b.ws.last('quality'), { t: 'quality', level: 'low', step: 1 });
  assert.deepEqual(a.ws.last('need').layers, [L_HI]);
  b.p.degradedAt -= 3000;
  for (let i = 0; i < 12; i++) a.ws.emit('message', vid(L_HI), true);
  assert.equal(b.ws.last('quality').step, 2);
  assert.deepEqual(a.ws.last('need').layers, [L_LO]);
  b.ws.bufferedAmount = 0; b.p.drops = []; b.p.degradedAt -= 20000; hub.tick();
  assert.deepEqual(a.ws.last('need').layers, [L_HI]); assert.equal(b.ws.last('quality').step, 1);
  b.p.degradedAt -= 20000; hub.tick();
  assert.deepEqual(a.ws.last('need').layers, [L_HD]); assert.equal(b.ws.last('quality').level, 'ok');
  hub.close();
});

test('état « vq » : hauteurs valides seulement, bornées par VIDEO_MAX_HEIGHT', () => {
  const { hub, join, ctl } = setup({ videoMaxHeight: 720 });
  const a = join('A'), b = join('B');
  ctl(a, { t: 'state', state: { vq: 1080 } }); assert.equal(b.ws.last('peer').state.vq, 720);
  ctl(a, { t: 'state', state: { vq: 4320 } }); assert.equal(b.ws.last('peer').state.vq, 720);
  ctl(a, { t: 'state', state: { vq: 360 } }); assert.equal(b.ws.last('peer').state.vq, 360);
  assert.equal(a.ws.last('welcome').maxHeight, 720);
  assert.equal(a.ws.last('welcome').bitrates.hd1080, 2500);
  hub.close();
});

test('codec : l\'ordre préféré de l\'émetteur est respecté (iPhone : H.264 matériel d\'abord)', () => {
  const { hub } = setup();
  const store = hub.store; const room = store.createRoom({ name: 'iOS', isPublic: true });
  const mk = (name, venc) => { const ws = new FakeWs(); hub.attach(ws, { room, name, sessionId: name });
    ws.emit('message', Buffer.from(JSON.stringify({ t: 'hello', name, caps: { venc, vdec: ['vp8', 'avc'], aenc: [], adec: [] } })), false); return ws; };
  const ios = mk('iPhone', ['avc', 'vp8']), pc = mk('PC', ['vp8', 'avc']);
  assert.equal(ios.last('codec').video, 'avc'); assert.equal(pc.last('codec').video, 'vp8');
  hub.close();
});
