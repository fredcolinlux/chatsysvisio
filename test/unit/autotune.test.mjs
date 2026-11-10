// Autotune (1.8) : détection de hauteur, correction vers la note juste, durée conservée, bruit et silence intacts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoTune, TUNE, scaleNote, noteName, hzToMidi, midiToHz, tuneLatency, speedTau } from '../../public/js/autotune.js';
import { singer } from '../../scripts/voix-synthese.mjs';

const run = (x, sr, o = {}) => { const a = new AutoTune(sr, o), y = new Float32Array(x.length); for (let i = 0; i < x.length; i += 128) a.process(x.subarray(i, i + 128), y.subarray(i, i + 128)); return { y, a }; };
const sine = (f, sec, sr, amp = 0.3) => { const n = Math.round(sec * sr), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / sr); return x; };
// fréquence moyenne par passages par zéro (interpolés), mesure indépendante du détecteur testé
function zcHz(y, sr, from, to) {
  let first = -1, last = -1, n = 0;
  for (let i = from + 1; i < to; i++) if (y[i - 1] < 0 && y[i] >= 0) { const t = i - 1 + -y[i - 1] / (y[i] - y[i - 1]); if (first < 0) first = t; last = t; n++; }
  return (n - 1) * sr / (last - first);
}
const cents = (f, ref) => 1200 * Math.log2(f / ref);
const noise = (n, amp, seed = 1) => { const x = new Float32Array(n); let s = seed; for (let i = 0; i < n; i++) { s = (s * 16807) % 2147483647; x[i] = amp * (s / 2147483647 * 2 - 1); } return x; };

test('notes : notation française (La 3 = 440 Hz), gamme chromatique, majeure et mineure, hystérésis', () => {
  assert.equal(noteName(69), 'La 3'); assert.equal(noteName(60), 'Do 3'); assert.equal(noteName(hzToMidi(261.63)), 'Do 3');
  assert.ok(Math.abs(midiToHz(69) - 440) < 1e-9);
  assert.equal(scaleNote(hzToMidi(450)), 69);                     // chromatique : La
  assert.equal(scaleNote(70.4), 70);                              // Si♭ existe en chromatique
  assert.equal(scaleNote(70.4, 0, false), 71);                    // Do majeur : pas de Si♭ → Si
  assert.equal(scaleNote(70.4, 0, true), 70);                     // Do mineur : Si♭
  assert.equal(scaleNote(61.2, 9, true), 62); assert.equal(scaleNote(60.6, 9, true), 60); // La mineur : pas de Do♯
  assert.equal(scaleNote(69.55, -1, false, 69), 69);              // hystérésis : on reste sur La
  assert.equal(scaleNote(69.7, -1, false, 69), 70);
  assert.equal(speedTau(100), 0); assert.ok(speedTau(0) > 0.1);
});

for (const sr of [48000, 44100]) {
  test(`sinusoïde 450 Hz → La 440 Hz en chromatique (${sr / 1000} kHz), toutes vitesses`, () => {
    for (const tuneSpeed of [100, 50, 0]) {
      const x = sine(450, 1.5, sr), { y, a } = run(x, sr, { tuneSpeed });
      const f = zcHz(y, sr, Math.round(sr * 0.8), y.length);
      assert.ok(Math.abs(cents(f, 440)) < 2, `vitesse ${tuneSpeed} : ${f.toFixed(2)} Hz`);
      assert.equal(a.info().note, 'La 3'); assert.equal(a.info().cents, -39);
      // amplitude constante : pas de battement entre les deux têtes de lecture (synchronisées sur la période)
      let mn = 1, mx = 0; for (let i = Math.round(sr * 0.6); i < y.length - 480; i += 480) { let p = 0; for (let j = 0; j < 480; j++) p = Math.max(p, Math.abs(y[i + j])); mn = Math.min(mn, p); mx = Math.max(mx, p); }
      assert.ok(mx - mn < 0.01, `ondulation ${mn}…${mx}`);
    }
  });
}

test('vitesse « robot » : correction quasi immédiate ; « naturel » : progressive', () => {
  const sr = 48000, x = sine(450, 0.3, sr);
  const fast = run(x, sr, { tuneSpeed: 100 }).y, slow = run(x, sr, { tuneSpeed: 0 }).y;
  const f1 = zcHz(fast, sr, Math.round(sr * 0.08), Math.round(sr * 0.13)), f0 = zcHz(slow, sr, Math.round(sr * 0.08), Math.round(sr * 0.13));
  assert.ok(Math.abs(cents(f1, 440)) < 4, `robot ${f1}`);
  assert.ok(cents(f0, 440) > 10, `naturel ${f0}`);
});

test('gamme : 470 Hz → Si (493,9 Hz) en Do majeur, Si♭ (466,2 Hz) en chromatique', () => {
  const sr = 48000, x = sine(470, 1.2, sr);
  const maj = run(x, sr, { tuneSpeed: 100, tuneKey: 0 }).y, chro = run(x, sr, { tuneSpeed: 100 }).y;
  assert.ok(Math.abs(cents(zcHz(maj, sr, sr * 0.6, maj.length), 493.88)) < 2);
  assert.ok(Math.abs(cents(zcHz(chro, sr, sr * 0.6, chro.length), 466.16)) < 2);
});

test('durée conservée : une note de 1 s ressort en 1 s, décalée de la seule latence fixe (≤ 30 ms)', () => {
  const sr = 48000, L = tuneLatency(sr), x = new Float32Array(sr * 2);
  const tone = sine(450, 1, sr); x.set(tone, sr / 2);
  const { y } = run(x, sr, { tuneSpeed: 100 });
  assert.equal(y.length, x.length);
  const on = a => a.findIndex(v => Math.abs(v) > 0.05), off = a => a.length - 1 - [...a].reverse().findIndex(v => Math.abs(v) > 0.05);
  assert.ok(Math.abs((on(y) - on(x)) - L) < sr * 0.004, `début ${(on(y) - on(x)) / sr * 1000} ms`);
  assert.ok(Math.abs((off(y) - on(y)) - (off(x) - on(x))) < sr * 0.012, `durée ${(off(y) - on(y)) / sr} s`);
  assert.ok(L / sr * 1000 <= 30); assert.equal(L, Math.ceil(sr * TUNE.latencyMs / 1000));
});

test('hors voix : bruit, silence et souffle ressortent identiques (à la latence près)', () => {
  for (const sr of [48000, 44100]) {
    const L = tuneLatency(sr);
    for (const x of [noise(sr, 0.2), noise(sr, 0.01, 9), new Float32Array(sr)]) {
      const { y, a } = run(x, sr, { tuneSpeed: 100 });
      let md = 0; for (let i = L; i < x.length; i++) md = Math.max(md, Math.abs(y[i] - x[i - L]));
      assert.equal(md, 0, `écart ${md}`); assert.equal(a.info().voiced, false);
    }
  }
});

test('voix chantée de synthèse (harmoniques, formants, vibrato) : ramenée sur les notes de Do majeur, sans clic', () => {
  const sr = 48000, notes = [[60, .6], [62, .6], [64, .6], [65, .6], [67, .9], [64, .6], [60, 1]], off = [35, -40, 30, -45, 38, -30, 42];
  const x = singer(sr, notes, { cents: off });
  const { y } = run(x, sr, { tuneSpeed: 100, tuneKey: 0 });
  const track = arr => { const d = new AutoTune(sr), z = new Float32Array(128), out = []; for (let i = 0; i < arr.length; i += 128) { d.process(arr.subarray(i, i + 128), z); if (d.voiced) out.push(d.midi); } return out; };
  const dev = arr => { const t = track(arr); return t.reduce((s, m) => s + Math.abs(m - Math.round(m)), 0) / t.length * 100; };
  const din = dev(x), dout = dev(y);
  assert.ok(din > 25 && dout < 6, `écart moyen entrée ${din.toFixed(1)} c, sortie ${dout.toFixed(1)} c`);
  let jx = 0, jy = 0; for (let i = 1; i < x.length; i++) { jx = Math.max(jx, Math.abs(x[i] - x[i - 1])); jy = Math.max(jy, Math.abs(y[i] - y[i - 1])); }
  assert.ok(jy < jx * 1.2, `sauts max entrée ${jx}, sortie ${jy}`);
});

test('détection : tessiture 80–1000 Hz, à 5 cents près, y compris un son riche en harmoniques', () => {
  const sr = 48000;
  for (const f of [82.4, 110, 196, 330, 523.3, 880, 990]) {
    const x = new Float32Array(sr * 0.5); for (let i = 0; i < x.length; i++) { const t = i / sr; x[i] = 0.2 * (Math.sin(2 * Math.PI * f * t) + 0.6 * Math.sin(4 * Math.PI * f * t) + 0.4 * Math.sin(6 * Math.PI * f * t)); }
    const { a } = run(x, sr, { tuneSpeed: 0 });
    assert.ok(Math.abs(cents(a.f0, f)) < 5, `${f} Hz détecté ${a.f0}`);
  }
});

test('coût : moins de 5 % d\'un cœur (Node, 48 kHz)', () => {
  const sr = 48000, x = singer(sr, [[57, 2], [64, 2]]), y = new Float32Array(x.length), a = new AutoTune(sr);
  for (let i = 0; i < sr; i += 128) a.process(x.subarray(i, i + 128), y.subarray(i, i + 128)); // chauffe
  const t0 = performance.now(); for (let i = 0; i < x.length; i += 128) a.process(x.subarray(i, i + 128), y.subarray(i, i + 128));
  const pct = (performance.now() - t0) / (x.length / sr * 1000) * 100;
  assert.ok(pct < 5, `${pct.toFixed(2)} %`);
});
