// Traitement du micro : dé-esseur (DSP pur), réglages enregistrés et paramètres du compresseur.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Deesser, bandpass, parseFx, FX_DEFAULTS, COMPRESSOR, COMPRESSOR_MAKEUP_DB } from '../../public/js/dsp.js';
import { loadFx, saveFx, FX_KEY } from '../../public/js/micfx.js';

const SR = 48000;
const tone = (f, db, sec = 0.5, sr = SR) => { const a = dbLin(db), n = Math.round(sec * sr), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = a * Math.sin(2 * Math.PI * f * i / sr); return x; };
const dbLin = db => 10 ** (db / 20);
const rmsDb = (x, from = 0.2) => { let s = 0, n = 0; for (let i = Math.floor(x.length * from); i < x.length; i++) { s += x[i] * x[i]; n++; } return 10 * Math.log10(s / n + 1e-20); };
const run = (x, sr = SR) => { const d = new Deesser(sr), y = new Float32Array(x.length); for (let i = 0; i < x.length; i += 128) d.process(x.subarray(i, i + 128), y.subarray(i, i + 128)); return { y, d }; };

test('passe-bande 5–9 kHz : 0 dB au centre, très atténué à 300 Hz', () => {
  const f = bandpass(SR, 5000, 9000);
  const resp = hz => { const w = 2 * Math.PI * hz / SR, re = (a, b, c) => a + b * Math.cos(-w) + c * Math.cos(-2 * w), im = (a, b, c) => b * Math.sin(-w) + c * Math.sin(-2 * w);
    const nr = re(f.b0, f.b1, f.b2), ni = im(f.b0, f.b1, f.b2), dr = re(1, f.a1, f.a2), di = im(1, f.a1, f.a2); return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di)); };
  assert.ok(Math.abs(resp(Math.sqrt(5000 * 9000))) < 0.1);
  assert.ok(resp(300) < -20, `300 Hz : ${resp(300)}`);
});

test('dé-esseur : une sifflante (7 kHz forte) est atténuée d\'au moins 6 dB', () => {
  const x = tone(7000, -10), { y, d } = run(x);
  const cut = rmsDb(x) - rmsDb(y);
  assert.ok(cut >= 6, `atténuation ${cut.toFixed(1)} dB`);
  assert.ok(d.takeReduction() >= 6);
});

test('dé-esseur : une voyelle (300 Hz) passe sans modification', () => {
  const x = tone(300, -10), { y, d } = run(x);
  let maxDiff = 0; for (let i = 0; i < x.length; i++) maxDiff = Math.max(maxDiff, Math.abs(x[i] - y[i]));
  assert.ok(maxDiff < 1e-3, `écart ${maxDiff}`);
  assert.ok(d.takeReduction() < 0.1);
});

test('dé-esseur : un aigu faible (sous le seuil) n\'est pas touché', () => {
  const x = tone(7000, -50), { y } = run(x);
  assert.ok(Math.abs(rmsDb(x) - rmsDb(y)) < 0.5);
});

test('dé-esseur : voix forte + léger aigu (bande < niveau global − 9 dB) : rien n\'est retiré', () => {
  const a = tone(250, -8), b = tone(6500, -30), x = a.map((v, i) => v + b[i]), { y } = run(x);
  assert.ok(Math.abs(rmsDb(x) - rmsDb(y)) < 0.3);
});

test('dé-esseur : atténuation plafonnée (maxCut) et fréquence d\'échantillonnage 44,1 kHz', () => {
  const x = tone(7000, 0, 0.5, 44100), { y } = run(x, 44100);
  const cut = rmsDb(x) - rmsDb(y);
  assert.ok(cut > 6 && cut <= 14.5, `atténuation ${cut.toFixed(1)} dB`);
  for (const v of y) assert.ok(Number.isFinite(v));
});

test('réglages : trois interrupteurs indépendants, coupés par défaut, valeurs invalides ignorées', () => {
  assert.deepEqual(parseFx(null), { comp: false, deess: false, ns: false });
  assert.deepEqual(parseFx('{"comp":true,"ns":"oui","x":1}'), { ...FX_DEFAULTS, comp: true });
  assert.deepEqual(parseFx('pas du json'), FX_DEFAULTS);
  const mem = new Map(), st = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)) };
  saveFx({ comp: false, deess: true, ns: true }, st);
  assert.equal(JSON.parse(mem.get(FX_KEY)).deess, true);
  assert.deepEqual(loadFx(st), { comp: false, deess: true, ns: true });
});

test('compresseur : réglages « voix » dans les bornes de DynamicsCompressorNode', () => {
  assert.ok(COMPRESSOR.threshold >= -100 && COMPRESSOR.threshold <= 0);
  assert.ok(COMPRESSOR.knee >= 0 && COMPRESSOR.knee <= 40);
  assert.ok(COMPRESSOR.ratio >= 1 && COMPRESSOR.ratio <= 20);
  assert.ok(COMPRESSOR.attack >= 0 && COMPRESSOR.attack <= 1 && COMPRESSOR.release >= 0 && COMPRESSOR.release <= 1);
  assert.ok(COMPRESSOR_MAKEUP_DB >= 0 && COMPRESSOR_MAKEUP_DB <= 12);
});
