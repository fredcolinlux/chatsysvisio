import test from 'node:test';
import assert from 'node:assert/strict';
import { pack, unpack, setSid, peekKey, peekLayer, peekLevel, T_VIDEO, T_AUDIO, F_KEY, CODECS, HEADER } from '../../public/js/protocol.js';
import { AdpcmEncoder, adpcmDecode, Resampler, rmsLevel } from '../../public/js/adpcm.js';

test('protocole : pack/unpack aller-retour', () => {
  const pl = new Uint8Array([1, 2, 3, 4, 5]);
  const u8 = pack({ type: T_VIDEO, sid: 513, layer: 1, flags: F_KEY, codec: CODECS.vp8, ts: 0xdeadbeef, level: 300, seq: 257 }, pl);
  assert.equal(u8.length, HEADER + 5);
  const p = unpack(u8);
  assert.deepEqual({ ...p, payload: [...p.payload] }, { type: 1, sid: 513, layer: 1, flags: 1, codec: 1, ts: 0xdeadbeef, level: 255, seq: 1, payload: [1, 2, 3, 4, 5] });
  setSid(u8, 7); assert.equal(unpack(u8).sid, 7);
  assert.equal(peekKey(u8), true); assert.equal(peekLayer(u8), 1); assert.equal(peekLevel(u8), 255);
  assert.equal(unpack(new Uint8Array(3)), null);
});

test('ADPCM : encodage/décodage fidèle (SNR > 20 dB)', () => {
  const enc = new AdpcmEncoder(); let sig = 0, noise = 0;
  for (let f = 0; f < 10; f++) {
    const s = new Float32Array(320);
    for (let i = 0; i < 320; i++) s[i] = 0.5 * Math.sin(2 * Math.PI * 440 * (f * 320 + i) / 16000);
    const b = enc.encode(s); assert.equal(b.length, 164);
    const d = adpcmDecode(b); assert.equal(d.length, 320);
    if (f > 0) for (let i = 0; i < 320; i++) { sig += s[i] ** 2; noise += (s[i] - d[i]) ** 2; }
  }
  assert.ok(10 * Math.log10(sig / noise) > 20);
});

test('rééchantillonneur : 48 kHz → 16 kHz → 48 kHz garde la durée', () => {
  const down = new Resampler(48000, 16000), up = new Resampler(16000, 48000);
  let n = 0, m = 0;
  for (let i = 0; i < 50; i++) { const o = down.process(new Float32Array(960)); n += o.length; m += up.process(o).length; }
  assert.ok(Math.abs(n - 16000) <= 2, `n=${n}`); assert.ok(Math.abs(m - 48000) <= 4, `m=${m}`);
});

test('niveau audio : silence = 0, plein niveau = 255', () => {
  assert.equal(rmsLevel(new Float32Array(100)), 0);
  assert.equal(rmsLevel(new Float32Array(100).fill(1)), 255);
});
