import test from 'node:test';
import assert from 'node:assert/strict';
import { pack, setSid, T_VIDEO, T_AUDIO, F_KEY, CODECS, HEADER } from '../../public/js/protocol.js';
import {
  rand, b64u, unb64u, parseKeyFragment, keyFragment, passwordKey, accessToken, roomSecret, RoomKeys, MediaCrypto,
  KeyAgreement, encryptFile, decryptFile, sniffImage, ReplayWindow, safetyCode, modeFor, verifyAnnouncement, roundLevel,
} from '../../public/js/e2ee.js';

const salt = rand(16);
const keysFor = async secret => RoomKeys.create(await roomSecret({ link: secret, salt }), salt);
const frame = (pl, o = {}) => pack({ type: T_VIDEO, layer: 1, flags: F_KEY, codec: CODECS.vp8, ts: 1234, level: 0, ...o }, pl);

test('e2ee : base64url et fragment #k=', () => {
  const s = rand(32);
  assert.deepEqual(unb64u(b64u(s)), s);
  assert.deepEqual(parseKeyFragment('#' + keyFragment(s)), s);
  assert.equal(parseKeyFragment(''), null);
  assert.equal(parseKeyFragment('#x=1'), null);
  assert.equal(parseKeyFragment('#k=abc'), false);
  assert.equal(parseKeyFragment('#k=' + b64u(s) + '!'), false);
  assert.throws(() => unb64u('a'));
});

test('e2ee : modes par type de salon', () => {
  assert.equal(modeFor({ isPublic: false }), 'link');
  assert.equal(modeFor({ isPublic: false, password: 'x' }), 'link+pw');
  assert.equal(modeFor({ isPublic: true, password: 'x' }), null);
  assert.equal(modeFor({ isPublic: true }), null);
});

test('e2ee : dérivations — vérificateur du mot de passe ≠ clé, étiquettes distinctes, déterministe', async () => {
  const pk = await passwordKey('cheval correct', salt, 1000);
  assert.deepEqual(pk, await passwordKey('cheval correct', salt, 1000));
  assert.notDeepEqual(pk, await passwordKey('cheval correct', rand(16), 1000));
  const token = await accessToken(pk, salt);
  const pwOnly = await roomSecret({ pwKey: pk, salt });
  assert.notEqual(token, b64u(pwOnly));
  assert.notEqual(token, b64u(pk));
  const link = rand(32);
  const both = await roomSecret({ link, pwKey: pk, salt }), linkOnly = await roomSecret({ link, salt });
  assert.notDeepEqual(both, linkOnly); assert.notDeepEqual(both, pwOnly);
  const k = await RoomKeys.create(both, salt), k2 = await RoomKeys.create(both, salt);
  assert.equal(k.kcv, k2.kcv); assert.equal(k.safety, k2.safety);
  assert.match(k.safety, /^\d{4} \d{4} \d{4}$/);
  assert.notEqual(k.kcv, token);
  const other = await RoomKeys.create(linkOnly, salt);
  assert.notEqual(k.kcv, other.kcv); assert.notEqual(k.safety, other.safety);
  await assert.rejects(roomSecret({ salt }));
  assert.equal(safetyCode(new Uint8Array(16)), '0000 0000 0000');
});

test('e2ee : chat — chiffré opaque, AAD lié à l\'usage, mauvaise clé et altération refusées', async () => {
  const k = await keysFor(rand(32)), bad = await keysFor(rand(32));
  const msg = { text: 'Bonjour secret', n: 'Alice' };
  const a = await k.seal(msg, 'chat'), b = await k.seal(msg, 'chat');
  assert.notEqual(a, b, 'IV aléatoire');
  assert.ok(!a.includes('Bonjour') && !Buffer.from(unb64u(a)).toString('latin1').includes('Bonjour'));
  assert.deepEqual(await k.open(a, 'chat'), msg);
  await assert.rejects(k.open(a, 'react:1'), { code: 'auth' });
  await assert.rejects(bad.open(a, 'chat'), { code: 'auth' });
  const u = unb64u(a); u[20] ^= 1;
  await assert.rejects(k.open(b64u(u), 'chat'), { code: 'auth' });
  await assert.rejects(k.open('***', 'chat'), { code: 'auth' });
});

test('e2ee : trames média — IV uniques, en-tête authentifié (AAD), sid/seq réécrits tolérés', async () => {
  const k = await keysFor(rand(32));
  const tx = new MediaCrypto(k), rx = new MediaCrypto(k);
  const pl = new Uint8Array(500).fill(7);
  const ivs = new Set(); const outs = [];
  for (let i = 0; i < 300; i++) { const o = await tx.encrypt(frame(pl)); outs.push(o); ivs.add(b64u(o.subarray(HEADER, HEADER + 7))); }
  assert.equal(ivs.size, 300, 'compteur unique par trame');
  const o = outs[0];
  assert.equal(o.length, HEADER + 7 + 500 + 16);
  assert.ok(!Buffer.from(o.subarray(HEADER)).includes(Buffer.from(pl.subarray(0, 16))), 'charge utile chiffrée');
  setSid(o, 42); o[11] = 99; // le serveur réécrit le sid, le client pose seq
  assert.deepEqual(await rx.decrypt(o, tx.nonce), pl);
  for (const [i, idx] of [[1, 0], [2, 3], [3, 4], [4, 5], [5, 6], [6, 10], [7, HEADER], [8, HEADER + 3], [9, HEADER + 7], [10, o.length - 1]]) {
    const t = outs[i].slice(); t[idx] ^= 1;
    await assert.rejects(rx.decrypt(t, tx.nonce), e => ['auth', 'nokey'].includes(e.code), `octet ${idx} altéré`);
  }
  // Deux émetteurs avec la même clé de salon : clés différentes (nonce), donc pas de collision d'IV
  const tx2 = new MediaCrypto(k);
  const c2 = await tx2.encrypt(frame(pl));
  assert.deepEqual(c2.subarray(HEADER, HEADER + 7), outs[0].subarray(HEADER, HEADER + 7));
  await assert.rejects(rx.decrypt(c2, tx.nonce), { code: 'auth' });
  assert.deepEqual(await rx.decrypt(c2, tx2.nonce), pl);
  // Mauvaise clé de salon
  const other = new MediaCrypto(await keysFor(rand(32)));
  await assert.rejects(other.decrypt(outs[20], tx.nonce), { code: 'auth' });
  // Trame en clair (ancien client) refusée
  await assert.rejects(rx.decrypt(frame(new Uint8Array(10)), tx.nonce), { code: 'auth' });
});

test('e2ee : rejeu refusé, désordre léger accepté', async () => {
  const k = await keysFor(rand(32));
  const tx = new MediaCrypto(k), rx = new MediaCrypto(k);
  const a = await tx.encrypt(frame(new Uint8Array(30), { type: T_AUDIO, codec: CODECS.opus, layer: 0, flags: 0 }));
  const b = await tx.encrypt(frame(new Uint8Array(30)));
  await rx.decrypt(b, tx.nonce); await rx.decrypt(a, tx.nonce);
  await assert.rejects(rx.decrypt(a, tx.nonce), { code: 'replay' });
  await assert.rejects(rx.decrypt(b, tx.nonce), { code: 'replay' });
  const w = new ReplayWindow(16);
  assert.ok(w.accept(100)); assert.ok(!w.accept(100)); assert.ok(w.accept(90)); assert.ok(!w.accept(84)); assert.ok(w.accept(101));
});

test('e2ee : époques — clé inconnue signalée, nouvelle clé acceptée', async () => {
  const k = await keysFor(rand(32));
  const tx = new MediaCrypto(k), rx = new MediaCrypto(k);
  const tag = tx.newTag(), raw = rand(32); tx.addEpoch(tag, raw); tx.cur = tag;
  const f = await tx.encrypt(frame(new Uint8Array(20)));
  await assert.rejects(rx.decrypt(f, tx.nonce), e => e.code === 'nokey' && e.tag === tag);
  rx.addEpoch(tag, raw);
  assert.equal((await rx.decrypt(f, tx.nonce)).length, 20);
  assert.equal(tx.addEpoch(0, raw), false);
  for (let i = 0; i < 20; i++) tx.addEpoch(tx.newTag(), rand(32));
  assert.ok(tx.epochs.size <= 9 && tx.epochs.has(0) && tx.epochs.has(tag));
  assert.equal(roundLevel(37), 32); assert.equal(roundLevel(255), 255);
});

test('e2ee : fichiers — blob opaque, clé par fichier, signature d\'image vérifiée côté client', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const a = await encryptFile(png), b = await encryptFile(png);
  assert.notEqual(a.key, b.key);
  assert.equal(Buffer.from(a.blob.subarray(0, 4)).toString(), 'CCE1');
  assert.ok(!Buffer.from(a.blob).includes(Buffer.from('PNG')));
  const out = await decryptFile(a.blob.buffer, a.key);
  assert.deepEqual(out, png);
  assert.ok(sniffImage(out, 'image/png')); assert.ok(!sniffImage(out, 'image/jpeg'));
  await assert.rejects(decryptFile(a.blob, b.key), { code: 'auth' });
  await assert.rejects(decryptFile(png, a.key), { code: 'auth' });
});

test('e2ee : accord de clés — annonce authentifiée, rotation au départ, la personne partie n\'a pas la nouvelle clé', async () => {
  const k = await keysFor(rand(32));
  const net = []; // messages « serveur »
  const mk = async (id, sid) => {
    const media = new MediaCrypto(k);
    const ka = await new KeyAgreement({ keys: k, media, send: m => net.push({ from: id, m }), readyTimeout: 50 }).init();
    return { id, sid, media, ka };
  };
  const A = await mk('a', 1), B = await mk('b', 2), X = await mk('x', 3);
  const all = [A, B, X];
  const deliver = async () => {
    while (net.length) {
      const { from, m } = net.shift(); const src = all.find(p => p.id === from);
      if (m.op === 'ann') for (const p of all) if (p !== src) await p.ka.onJson({ t: 'e2ee', op: 'ann', from, ann: m.ann });
      if (m.op === 'key') { const dst = all.find(p => p.id === m.to); if (dst) await dst.ka.onJson({ t: 'e2ee', op: 'key', from, w: m.w }); }
    }
  };
  const info = p => ({ id: p.id, sid: p.sid });
  await A.ka.onJson({ t: 'welcome', you: info(A), peers: [] });
  assert.ok(A.ka.canSend());
  for (const p of [B, X]) {
    for (const o of all.filter(o => o !== p && o.ka.me)) await o.ka.onJson({ t: 'join', peer: info(p) });
    await p.ka.onJson({ t: 'welcome', you: info(p), peers: all.filter(o => o !== p && o.ka.me).map(o => ({ ...info(o), ann: o.ka.ann })) });
    assert.ok(!p.ka.canSend(), 'attend la clé courante');
    await deliver();
    assert.ok(p.ka.ready);
  }
  assert.ok(A.ka.isLeader() && !B.ka.isLeader());
  // Annonce falsifiée (clé de salon différente) ignorée
  const forged = await new KeyAgreement({ keys: await keysFor(rand(32)), media: new MediaCrypto(k), send() {} }).init();
  assert.equal(await verifyAnnouncement(k, forged.ann), false);
  assert.equal(await verifyAnnouncement(k, A.ka.ann), true);
  // X est exclu : A (meneur) fait tourner la clé ; B la reçoit ; X non.
  all.splice(2, 1);
  for (const p of [A, B]) await p.ka.onJson({ t: 'leave', id: 'x', sid: 3 });
  await deliver();
  assert.notEqual(A.media.cur, 0); assert.equal(B.media.cur, A.media.cur);
  assert.ok(!X.media.epochs.has(A.media.cur));
  const f = await B.media.encrypt(frame(new Uint8Array(64).fill(1)));
  assert.equal((await A.media.decrypt(f, B.media.nonce)).length, 64);
  await assert.rejects(X.media.decrypt(f, B.media.nonce), { code: 'nokey' });
  // Le meneur part : B devient meneur et seul, aucun envoi nécessaire
  await B.ka.onJson({ t: 'leave', id: 'a', sid: 1 });
  assert.ok(B.ka.isLeader() && B.ka.canSend());
});
