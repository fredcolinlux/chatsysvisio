// Traitements du micro, sans dépendance au DOM : importés par l'AudioWorklet (worklets.js) et par les tests unitaires.

// Réglages « voix » du compresseur (DynamicsCompressorNode) : rapprochement des passages faibles et forts,
// attaque rapide pour tenir les consonnes, relâchement assez long pour ne pas « pomper ».
export const COMPRESSOR = Object.freeze({ threshold: -26, knee: 10, ratio: 4, attack: 0.004, release: 0.18 });
// Gain de compensation appliqué après le compresseur (en dB). Le nœud natif ajoute déjà un gain automatique
// (spécification Web Audio) ; ce complément ramène une voix normale (≈ -18 dBFS) à peu près au même niveau.
export const COMPRESSOR_MAKEUP_DB = 2;

// Dé-esseur : compression de la seule bande 5–9 kHz quand elle domine (les « s », « ch » sifflants).
export const DEESSER = Object.freeze({ lo: 5000, hi: 9000, threshold: -34, rel: -9, ratio: 4, maxCut: 14, attackMs: 1, releaseMs: 70 });

// Réglages enregistrés (localStorage 'csv-micfx') : quatre interrupteurs indépendants, tous coupés par défaut,
// et les réglages de l'autotune (vitesse 0–100, tonalité -1 = chromatique ou 0 = Do … 11 = Si, mode mineur).
export const FX_DEFAULTS = Object.freeze({ comp: false, deess: false, ns: false, tune: false, tuneSpeed: 50, tuneKey: -1, tuneMinor: false });
export function parseFx(raw) {
  let o = null; try { o = JSON.parse(raw); } catch {}
  const out = { ...FX_DEFAULTS };
  if (!o || typeof o !== 'object') return out;
  for (const k of ['comp', 'deess', 'ns', 'tune', 'tuneMinor']) if (typeof o[k] === 'boolean') out[k] = o[k];
  if (Number.isFinite(o.tuneSpeed) && o.tuneSpeed >= 0 && o.tuneSpeed <= 100) out.tuneSpeed = Math.round(o.tuneSpeed);
  if (Number.isInteger(o.tuneKey) && o.tuneKey >= -1 && o.tuneKey <= 11) out.tuneKey = o.tuneKey;
  return out;
}

const dbToLin = db => Math.pow(10, db / 20);
const linToDb = x => 20 * Math.log10(x + 1e-12);

// Passe-bande RBJ (gain 0 dB au centre), forme directe transposée.
export function bandpass(sr, lo, hi) {
  const nyq = sr / 2; hi = Math.min(hi, nyq * 0.9); lo = Math.min(lo, hi * 0.7);
  const f0 = Math.sqrt(lo * hi), q = f0 / (hi - lo), w = 2 * Math.PI * f0 / sr, al = Math.sin(w) / (2 * q), a0 = 1 + al;
  return { b0: al / a0, b1: 0, b2: -al / a0, a1: -2 * Math.cos(w) / a0, a2: (1 - al) / a0, z1: 0, z2: 0 };
}

// Dé-esseur à détection latérale : y = x − (1 − g)·bande(x). Hors sifflante g = 1 et la sortie est exactement
// l'entrée (aucune coloration) ; sur une sifflante, seule la bande 5–9 kHz est atténuée (jusqu'à maxCut dB).
// Le seuil suit aussi le niveau global : la bande doit dépasser (niveau global + rel dB), ce qui épargne
// une voix forte mais normale.
export class Deesser {
  constructor(sr, o = DEESSER) {
    this.o = o; this.bp = bandpass(sr, o.lo, o.hi);
    this.ka = Math.exp(-1 / (sr * o.attackMs / 1000)); this.kr = Math.exp(-1 / (sr * o.releaseMs / 1000));
    this.kf = Math.exp(-1 / (sr * 0.01)); // enveloppe globale (10 ms)
    this.envB = 0; this.envF = 0; this.g = 1; this.minG = 1;
  }
  process(x, y) {
    const f = this.bp, o = this.o, thrLin = dbToLin(o.threshold), floor = dbToLin(-o.maxCut), slope = 1 - 1 / o.ratio;
    let { z1, z2 } = f, { envB, envF, g } = this, minG = this.minG;
    for (let i = 0; i < x.length; i++) {
      const s = x[i];
      const b = f.b0 * s + z1; z1 = f.b1 * s - f.a1 * b + z2; z2 = f.b2 * s - f.a2 * b;
      const ab = Math.abs(b), as = Math.abs(s);
      envB = ab > envB ? this.ka * envB + (1 - this.ka) * ab : this.kr * envB + (1 - this.kr) * ab;
      envF = this.kf * envF + (1 - this.kf) * as;
      let target = 1;
      const thr = Math.max(thrLin, envF * dbToLin(o.rel));
      if (envB > thr) { target = dbToLin(-(linToDb(envB) - linToDb(thr)) * slope); if (target < floor) target = floor; }
      // gain lissé (descente rapide, remontée au rythme du relâchement)
      g = target < g ? target + (g - target) * this.ka : target + (g - target) * this.kr;
      if (g < minG) minG = g;
      y[i] = s - (1 - g) * b;
    }
    f.z1 = z1; f.z2 = z2; this.envB = envB; this.envF = envF; this.g = g; this.minG = minG;
  }
  // Atténuation la plus forte appliquée depuis le dernier appel (en dB, ≥ 0) : affichage et tests.
  takeReduction() { const r = -linToDb(this.minG); this.minG = this.g; return Math.max(0, r); }
}
