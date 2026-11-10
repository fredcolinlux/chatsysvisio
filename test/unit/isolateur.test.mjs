// Isolateur de voix (1.9) : tampons et latence exacte, rééchantillonnage 44,1 ↔ 48 kHz, porte de proximité, et
// DeepFilterNet3 réel (le même wasm que celui servi aux navigateurs) sur des mélanges de synthèse : voix + musique,
// voix + voix lointaine, voix + bruit. Mesures : niveau de la musique pendant tes pauses, distance spectrale à ta voix
// pendant que tu parles, part de tes trames de parole abîmées.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { IsoStream, ProximityGate, Hermite, ISO, isoParams, isoLatency, isoBuffer } from '../../public/js/isolateur.js';
import { dfInit } from '../../public/js/df-glue.js';
import { parole, musique, lointain } from '../../scripts/voix-synthese.mjs';
import { parseFx, FX_DEFAULTS } from '../../public/js/dsp.js';

const WASM = new URL('../../node_modules/@lofcz/deepfilternet-web/dist/df_bg.wasm', import.meta.url);
const hasDf = fs.existsSync(WASM);
let glue = null; const G = () => (glue ||= dfInit(new WebAssembly.Module(fs.readFileSync(WASM))));
const realDf = () => { const g = G(), st = g.create(100); return { process: f => g.process(st, f), setAttenLim: d => g.setAttenLim(st, d) }; };
// simulation de DeepFilterNet : identité retardée de 30 ms (même délai que le vrai modèle)
const delayDf = () => { const q = new Float32Array(ISO.dfDelay + ISO.frame); return { setAttenLim() {}, process(f) { q.copyWithin(0, ISO.frame); q.set(f, ISO.dfDelay); return q.slice(0, ISO.frame); } }; };
function run(x, sr, df, level = 60, block = 128) {
  const s = new IsoStream(sr, df, level), y = new Float32Array(x.length);
  for (let i = 0; i + block <= x.length; i += block) s.process(x.subarray(i, i + block), y.subarray(i, i + block));
  return { y, s };
}
const dbE = (a, b = 0, c = a.length) => { let e = 0; for (let i = b; i < c; i++) e += a[i] * a[i]; return 10 * Math.log10(e / Math.max(1, c - b) + 1e-20); };
const mixAt = (v, o, relDb) => { const k = 10 ** ((relDb - (dbE(o) - dbE(v))) / 20); return v.map((q, i) => q + k * o[i]); };
// enveloppe de la voix proche : pauses = là où elle est (quasi) nulle
const pausesOf = v => { const m = new Uint8Array(v.length); let s = 0; for (let i = 0; i < v.length; i++) { s = Math.max(Math.abs(v[i]), s * 0.9995); m[i] = s < 1e-3; } return m; };
function inPauses(x, y, mask, L) { let a = 0, b = 0; for (let i = 0; i + L < x.length; i++) if (mask[i]) { a += x[i] ** 2; b += y[i + L] ** 2; } return 10 * Math.log10(b / a); }
// distance spectrale log moyenne (dB) à la voix seule, sur les trames où elle est présente (100 Hz – 8 kHz)
function lsd(y, ref, lag) {
  const N = 1024, w = Float32Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)), K0 = 3, K1 = 170;
  const cos = [], sin = []; for (let k = K0; k < K1; k++) { const c = new Float32Array(N), s = new Float32Array(N); for (let n = 0; n < N; n++) { c[n] = Math.cos(2 * Math.PI * k * n / N) * w[n]; s[n] = Math.sin(2 * Math.PI * k * n / N) * w[n]; } cos.push(c); sin.push(s); }
  const spec = (a, o) => cos.map((c, j) => { let r = 0, i = 0; for (let n = 0; n < N; n++) { const x = a[o + n] || 0; r += x * c[n]; i += x * sin[j][n]; } return 10 * Math.log10(r * r + i * i + 1e-9); });
  let tot = 0, cnt = 0;
  for (let o = 0; o + N + lag < ref.length; o += 2048) { if (dbE(ref, o, o + N) < -40) continue; const A = spec(ref, o), B = spec(y, o + lag); let d = 0; for (let k = 0; k < A.length; k++) d += Math.max(-40, Math.min(40, A[k] - B[k])) ** 2; tot += Math.sqrt(d / A.length); cnt++; }
  return tot / cnt;
}

test('réglages : interrupteur et intensité dans csv-micfx, anciens réglages relus, valeurs bornées', () => {
  assert.equal(FX_DEFAULTS.iso, false); assert.equal(FX_DEFAULTS.isoLevel, 60);
  assert.deepEqual(parseFx(JSON.stringify({ ns: true, comp: true, deess: true })), { ...FX_DEFAULTS, ns: true, comp: true, deess: true });
  assert.equal(parseFx(JSON.stringify({ iso: true, isoLevel: 87.6 })).isoLevel, 88);
  assert.equal(parseFx(JSON.stringify({ iso: 'oui', isoLevel: 300 })).iso, false);
  assert.equal(parseFx(JSON.stringify({ isoLevel: -1 })).isoLevel, 60);
  const lo = isoParams(0), hi = isoParams(100);
  assert.equal(lo.gateDepth, 0); assert.equal(lo.attenLim, 12); assert.equal(hi.attenLim, 60); assert.equal(hi.gateDepth, 30);
  assert.ok(hi.gateBelow < lo.gateBelow);
});

test('tampons : latence exacte de 39,3 ms à 48 kHz (30 ms de modèle + 9,3 ms d\'alignement 128 → 480), aucun trou', () => {
  assert.equal(isoLatency(48000), 1888); assert.equal(isoBuffer(48000), 448);
  const n = 48000, x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = Math.sin(i * 0.013) * Math.sin(i * 0.0007);
  for (const block of [128, 256]) {
    const { y, s } = run(x, 48000, delayDf(), 60, block);
    const L = isoLatency(48000); let max = 0; for (let i = 0; i + L < n - block; i++) max = Math.max(max, Math.abs(y[i + L] - x[i]));
    assert.ok(max < 1e-6, `bloc ${block} : sortie = entrée retardée de ${L} (écart ${max})`); assert.equal(s.underruns, 0);
  }
});

test('44,1 kHz : rééchantillonnage d\'Hermite vers 48 kHz et retour, latence 40,1 ms, son fidèle', () => {
  const h = new Hermite(44100, 48000), x = new Float32Array(44100); for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * 1000 * i / 44100);
  let out = []; for (let i = 0; i < x.length; i += 128) out.push(...h.process(x.subarray(i, i + 128)));
  assert.ok(Math.abs(out.length - 48000) <= 2, `${out.length} échantillons`);
  let err = 0; for (let i = 100; i < out.length - 100; i++) err = Math.max(err, Math.abs(out[i] - Math.sin(2 * Math.PI * 1000 * (i - 2 * 48000 / 44100) / 48000))); // retard : 2 échantillons d'entrée
  assert.ok(err < 0.01, `erreur ${err}`);
  const sr = 44100, v = parole(sr, 3), { y, s } = run(v, sr, delayDf());
  const L = isoLatency(sr); let c = 0, e1 = 0, e2 = 0; for (let i = 0; i + L < v.length - 512; i++) { c += v[i] * y[i + L]; e1 += v[i] ** 2; e2 += y[i + L] ** 2; }
  assert.ok(c / Math.sqrt(e1 * e2) > 0.995, `corrélation ${c / Math.sqrt(e1 * e2)}`); assert.equal(s.underruns, 0);
  assert.ok(L / sr * 1000 <= 40.2);
});

test('porte de proximité : la voix forte passe, une voix 20 dB plus faible est atténuée pendant tes pauses, rien à intensité 0', () => {
  const sr = 48000, F = 480, frame = amp => Float32Array.from({ length: F }, (_, i) => amp * Math.sin(i * 0.07));
  for (const [lvl, expectMin] of [[0, 0], [60, 15], [100, 25]]) {
    const g = new ProximityGate(); g.set(isoParams(lvl));
    for (let k = 0; k < 100; k++) g.process(frame(0.3)); // toi, 1 s
    assert.ok(g.takeReduction() < 0.5, 'ta voix n\'est pas atténuée');
    let last; for (let k = 0; k < 100; k++) last = g.process(frame(0.03)); // voix lointaine (−20 dB), 1 s
    const red = -20 * Math.log10(Math.max(...last.map(Math.abs)) / 0.03 + 1e-9);
    assert.ok(red >= expectMin - 0.5 && (lvl > 0 || red < 0.1), `intensité ${lvl} : −${red.toFixed(1)} dB`);
    for (let k = 0; k < 10; k++) last = g.process(frame(0.3));
    assert.ok(Math.max(...last.map(Math.abs)) > 0.29, 'rouvre dès que tu parles');
  }
});

test('DeepFilterNet3 : ta voix seule passe intacte (gain ±1 dB, distance spectrale faible)', { skip: !hasDf && 'wasm absent (npm ci)' }, () => {
  const sr = 48000, v = parole(sr, 6), L = isoLatency(sr), { y, s } = run(v, sr, realDf());
  const d = dbE(y, L, v.length) - dbE(v, 0, v.length - L);
  assert.ok(Math.abs(d) < 1, `gain ${d.toFixed(2)} dB`); assert.ok(lsd(y, v, L) < 2.5, 'distance spectrale'); assert.equal(s.underruns, 0);
});

test('voix + musique : musique −25 dB pendant tes pauses, musique seule −20 dB ou plus, voix plus proche de l\'original', { skip: !hasDf && 'wasm absent' }, () => {
  const sr = 48000, v = parole(sr, 8), m = musique(sr, 8), L = isoLatency(sr), mask = pausesOf(v);
  const mix = mixAt(v, m, -6), { y } = run(mix, sr, realDf(), 60);
  const p = inPauses(mix, y, mask, L), before = lsd(mix, v, 0), after = lsd(y, v, L);
  const only = run(mixAt(new Float32Array(v.length), m, 0).map((q, i) => m[i]), sr, realDf(), 60).y, mo = dbE(only, L) - dbE(m);
  console.log(`  musique −6 dB : pauses ${p.toFixed(1)} dB · distance spectrale ${before.toFixed(2)} → ${after.toFixed(2)} dB · musique seule ${mo.toFixed(1)} dB`);
  assert.ok(p < -25, `pauses ${p.toFixed(1)} dB`); assert.ok(mo < -20, `musique seule ${mo.toFixed(1)} dB`); assert.ok(after < before - 2, 'plus proche de ta voix');
  // intensité : plus forte = plus d'atténuation pendant les pauses
  const pLow = inPauses(mix, run(mix, sr, realDf(), 0).y, mask, L);
  assert.ok(pLow > p + 3, `intensité 0 : ${pLow.toFixed(1)} dB`);
});

test('voix lointaine : atténuée pendant tes pauses (plus fort avec l\'intensité), ta voix ensuite intacte', { skip: !hasDf && 'wasm absent' }, () => {
  const sr = 48000, S = 3 * sr, L = isoLatency(sr);
  const near = parole(sr, 9, { seed: 7 }), far = lointain(sr, parole(sr, 9, { f0: 190, seed: 42 }), { gainDb: -14, rt60: 0.3 });
  // 0–3 s : toi ; 3–6 s : quelqu'un parle au loin (tu te tais) ; 6–9 s : toi à nouveau
  const x = near.map((q, i) => (i < S || i >= 2 * S ? q : 0) + (i >= S && i < 2 * S ? far[i] : 0));
  const res = [0, 60, 100].map(l => { const { y } = run(x, sr, realDf(), l); return { l, far: dbE(y, S + L, 2 * S) - dbE(x, S, 2 * S - L), you: dbE(y, 2 * S + L, 3 * S) - dbE(x, 2 * S, 3 * S - L) }; });
  console.log('  voix lointaine −14 dB : ' + res.map(r => `intensité ${r.l} → ${r.far.toFixed(1)} dB (ta voix ${r.you.toFixed(1)} dB)`).join(' · '));
  assert.ok(res[1].far < -8 && res[2].far < -15, 'atténuée'); assert.ok(res[2].far < res[0].far - 8, 'la porte agit');
  for (const r of res) assert.ok(Math.abs(r.you) < 1, `ta voix ${r.you.toFixed(2)} dB`);
});

test('voix + bruit rose : bruit −25 dB dans les pauses, silence et absence de signal sans artefact', { skip: !hasDf && 'wasm absent' }, () => {
  const sr = 48000, v = parole(sr, 6), L = isoLatency(sr), n = new Float32Array(v.length);
  let s = 9, b0 = 0, b1 = 0; for (let i = 0; i < n.length; i++) { const r = (s = (s * 16807) % 2147483647) / 2147483647 * 2 - 1; b0 = 0.997 * b0 + 0.03 * r; b1 = 0.96 * b1 + 0.05 * r; n[i] = b0 + b1 + 0.02 * r; }
  const mix = mixAt(v, n, -6), { y } = run(mix, sr, realDf());
  assert.ok(inPauses(mix, y, pausesOf(v), L) < -25);
  const z = run(new Float32Array(sr * 2), sr, realDf()).y; assert.ok(z.every(q => Math.abs(q) < 1e-4), 'silence → silence');
});

test('CPU : DeepFilterNet3 + porte en temps réel avec marge (Node, un cœur)', { skip: !hasDf && 'wasm absent' }, () => {
  const sr = 48000, v = parole(sr, 10), df = realDf(); run(v.subarray(0, sr), sr, df);
  const t0 = performance.now(); run(v, sr, df); const load = (performance.now() - t0) / 10000;
  console.log(`  charge : ${(load * 100).toFixed(1)} % d'un cœur`);
  assert.ok(load < 0.15, `${(load * 100).toFixed(1)} %`);
});
