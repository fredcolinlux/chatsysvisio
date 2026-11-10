// Isolateur de voix (ChatSysVisio 1.9, AGPL-3.0-or-later) : DeepFilterNet3 (réseau de neurones de rehaussement de la
// parole, 48 kHz, trames de 10 ms) + « porte de proximité » qui atténue les voix nettement plus faibles que la tienne
// (voix lointaines, de second plan) quand tu ne parles pas. Ce module ne dépend d'aucune API du navigateur : il sert
// au worklet (isolateur-worklet.js) et aux tests unitaires dans Node.
//
// Ce que fait vraiment chaque partie :
// - DeepFilterNet3 garde la parole et retire ce qui n'en est pas : musique, télé (hors voix), ventilation, clavier,
//   vaisselle, circulation… Il ne sait pas QUI parle : une autre voix claire et proche est gardée comme la tienne.
// - La porte de proximité suit le niveau de ta voix (la plus forte, près du micro) et atténue ce qui reste nettement
//   en dessous quand tu te tais. Pendant que tu parles, elle reste ouverte : elle ne sépare pas deux voix simultanées.
export const ISO = {
  sr: 48000, frame: 480, dfDelay: 1440, // libDF : fenêtre de 960, pas de 480, anticipation de 2 trames → 30 ms
  holdMs: 120, attackMs: 3, releaseMs: 70, refDecayDbPerS: 0.5, refMinDb: -50, kneeDb: 6,
  maxLoad: 0.85, // part du temps réel au-delà de laquelle l'appareil est jugé trop lent
};
export const ISO_DEFAULTS = { isoLevel: 60 };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
// Intensité 0..100 → limite d'atténuation de DeepFilterNet (12 → 60 dB) et porte de proximité (0 → −30 dB, seuil
// 16 → 6 dB sous ta voix).
export function isoParams(level = ISO_DEFAULTS.isoLevel) {
  const l = clamp(+level || 0, 0, 100) / 100;
  return { attenLim: 12 + 48 * l, gateDepth: 30 * l, gateBelow: 16 - 10 * l };
}
// Tampon fixe pour passer des blocs de 128 échantillons du navigateur aux trames de 480 (aucun trou possible).
export const isoBuffer = sr => sr === ISO.sr ? 448 : Math.ceil(ISO.frame * sr / ISO.sr) + 2;
// Latence totale ajoutée, en échantillons à la fréquence du contexte audio.
export const isoLatency = sr => sr === ISO.sr ? ISO.dfDelay + isoBuffer(sr) : Math.round(ISO.dfDelay * sr / ISO.sr) + isoBuffer(sr) + 4;

// Rééchantillonneur d'Hermite (4 points) avec état, rapport quelconque (44,1 ↔ 48 kHz).
export class Hermite {
  constructor(from, to) { this.step = from / to; this.pos = 1; this.h = new Float32Array(3); this.buf = new Float32Array(0); this.out = new Float32Array(0); }
  process(x) {
    const n = x.length + 3;
    if (this.buf.length < n) this.buf = new Float32Array(n);
    const b = this.buf; b.set(this.h, 0); b.set(x, 3);
    const max = Math.ceil(n / this.step) + 2; if (this.out.length < max) this.out = new Float32Array(max);
    let pos = this.pos, k = 0; const o = this.out;
    while (pos + 2 < n) {
      const i = Math.floor(pos), f = pos - i, xm = b[i - 1], x0 = b[i], x1 = b[i + 1], x2 = b[i + 2];
      const c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
      o[k++] = ((c3 * f + c2) * f + c1) * f + x0; pos += this.step;
    }
    this.pos = pos - x.length; this.h.set(b.subarray(n - 3, n));
    return o.subarray(0, k);
  }
}

// File circulaire simple.
class Fifo {
  constructor(n) { this.b = new Float32Array(n); this.r = 0; this.w = 0; this.n = 0; }
  push(x) { const b = this.b, L = b.length; for (let i = 0; i < x.length; i++) { b[this.w] = x[i]; this.w = (this.w + 1) % L; } this.n += x.length; if (this.n > L) { this.r = (this.r + this.n - L) % L; this.n = L; } }
  zeros(k) { this.push(new Float32Array(k)); }
  pull(y) { const b = this.b, L = b.length; if (this.n < y.length) return false; for (let i = 0; i < y.length; i++) { y[i] = b[this.r]; this.r = (this.r + 1) % L; } this.n -= y.length; return true; }
}

// Porte de proximité, appliquée trame par trame (10 ms à 48 kHz) sur la sortie de DeepFilterNet.
export class ProximityGate {
  constructor(sr = ISO.sr, frame = ISO.frame) {
    this.sr = sr; this.frame = frame; this.ref = -120; this.hold = 0; this.g = 1; this.minG = 1;
    this.aA = 1 - Math.exp(-1 / (sr * ISO.attackMs / 1000)); this.aR = 1 - Math.exp(-1 / (sr * ISO.releaseMs / 1000));
    this.decay = ISO.refDecayDbPerS * frame / sr; this.set(isoParams());
  }
  set({ gateDepth, gateBelow }) { this.depth = gateDepth; this.below = gateBelow; this.floor = Math.pow(10, -gateDepth / 20); }
  process(y) {
    let e = 0; for (let i = 0; i < y.length; i++) e += y[i] * y[i];
    const L = 10 * Math.log10(e / y.length + 1e-12);
    // niveau de référence = ta voix : suit vite les passages forts, redescend lentement (0,5 dB/s)
    if (L > this.ref) this.ref += (L - this.ref) * 0.35; else this.ref = Math.max(-120, this.ref - this.decay);
    let target = 1;
    if (this.depth > 0 && this.ref > ISO.refMinDb) {
      const d = (this.ref - this.below) - L; // > 0 : nettement plus faible que ta voix
      if (d <= 0) this.hold = Math.round(ISO.holdMs / 1000 * this.sr / this.frame);
      else if (this.hold > 0) this.hold--;
      else target = d >= ISO.kneeDb ? this.floor : 1 - (1 - this.floor) * d / ISO.kneeDb;
    }
    let g = this.g, m = 1;
    for (let i = 0; i < y.length; i++) { g += (target - g) * (target > g ? this.aA : this.aR); y[i] *= g; if (g < m) m = g; }
    this.g = g; this.minG = Math.min(this.minG, m);
    return y;
  }
  takeReduction() { const db = this.minG < 1 ? -20 * Math.log10(this.minG) : 0; this.minG = 1; return db; }
}

// Flux complet : blocs du navigateur (fréquence quelconque) → trames 48 kHz → DeepFilterNet → porte → blocs.
// df : { process(trame) → Float32Array, setAttenLim(dB) } (libDF réelle, ou simulation dans les tests).
export class IsoStream {
  constructor(sr, df, level = ISO_DEFAULTS.isoLevel) {
    this.sr = sr; this.df = df; this.rs = sr !== ISO.sr;
    this.up = this.rs ? new Hermite(sr, ISO.sr) : null; this.down = this.rs ? new Hermite(ISO.sr, sr) : null;
    this.inQ = new Fifo(ISO.frame * 8); this.outQ = new Fifo(Math.ceil(ISO.frame * 8 * sr / ISO.sr) + 1024);
    this.outQ.zeros(isoBuffer(sr));
    this.frameBuf = new Float32Array(ISO.frame);
    this.dry = new Fifo(ISO.dfDelay + ISO.frame * 2); this.dry.zeros(ISO.dfDelay); this.dryOut = new Float32Array(ISO.frame);
    this.gate = new ProximityGate(); this.bypass = false; this.underruns = 0; this.frames = 0;
    this.set(level);
  }
  set(level) { this.level = level; const p = isoParams(level); this.gate.set(p); try { this.df?.setAttenLim(p.attenLim); } catch {} }
  process(x, y) {
    this.inQ.push(this.rs ? this.up.process(x) : x);
    while (this.inQ.n >= ISO.frame) {
      this.inQ.pull(this.frameBuf);
      // chemin sec retardé de la même latence que le modèle : bascule sans saut si l'appareil est trop lent
      this.dry.push(this.frameBuf); this.dry.pull(this.dryOut);
      let out;
      if (this.bypass || !this.df) out = this.dryOut;
      else { out = this.df.process(this.frameBuf); this.gate.process(out); }
      this.frames++;
      this.outQ.push(this.rs ? this.down.process(out) : out);
    }
    if (!this.outQ.pull(y)) { y.fill(0); this.underruns++; }
  }
}
