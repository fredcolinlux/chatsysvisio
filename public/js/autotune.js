// Autotune (correction de justesse) : DSP pur, sans DOM, partagé par l'AudioWorklet (autotune-worklet.js) et les tests.
// Implémentation originale ChatSysVisio (AGPL-3.0-or-later), d'après des algorithmes publiés :
//  · hauteur : YIN (A. de Cheveigné et H. Kawahara, JASA 2002) sur le signal décimé à ~12 kHz, affiné à pleine
//    fréquence (différence carrée autour de la période trouvée + interpolation parabolique) ;
//  · décalage sans changer la durée : deux têtes de lecture dans une ligne à retard, fenêtres sin² en quadrature
//    (somme = 1), dont l'écart est un multiple de la période de la voix (synchronisé à la hauteur, à la manière de
//    PSOLA) : les deux têtes lisent la même phase de l'onde, donc ni écho ni « flanger » ;
//  · correction vers la note la plus proche (chromatique ou gamme majeure / mineure), lissée selon la vitesse.
// Hors voix (silence, bruit, consonnes sourdes), la sortie est exactement l'entrée retardée de la latence fixe.

export const TUNE = Object.freeze({
  fmin: 70, fmax: 1000,   // tessiture détectée (Hz)
  latencyMs: 13,          // retard fixe ajouté (le même avec ou sans voix : pas de saut de synchronisation)
  windowMs: 16,           // fenêtre d'intégration de YIN
  hopMs: 5,               // une analyse toutes les ~5 ms
  yin: 0.15,              // seuil YIN (premier creux sous ce seuil)
  voiced: 0.25,           // au-delà : son non voisé (bruit, souffle, « s »), laissé intact
  gateDb: -50,            // en dessous : silence, laissé intact
  maxTauMs: 140,          // constante de lissage de la correction à la vitesse 0 (« naturel »)
  spanMs: 16,             // écart visé entre les deux têtes (multiple de la période)
});
export const TUNE_DEFAULTS = Object.freeze({ tuneSpeed: 50, tuneKey: -1, tuneMinor: false });
export const NOTE_NAMES = ['Do', 'Do♯', 'Ré', 'Mi♭', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'Si♭', 'Si'];
export const SCALES = Object.freeze({ major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10] });

export const hzToMidi = f => 69 + 12 * Math.log2(f / 440);
export const midiToHz = m => 440 * 2 ** ((m - 69) / 12);
// Notation française : La 3 = 440 Hz (MIDI 69).
export const noteName = m => { const n = Math.round(m); return `${NOTE_NAMES[((n % 12) + 12) % 12]} ${Math.floor(n / 12) - 2}`; };
export const tuneLatency = sr => Math.ceil(sr * TUNE.latencyMs / 1000);
// Lissage de la correction : vitesse 0 = naturel (≈ 140 ms), 100 = instantané (effet « robot »).
export const speedTau = speed => TUNE.maxTauMs / 1000 * (1 - Math.min(100, Math.max(0, speed)) / 100) ** 2;

// Note cible (MIDI entier) pour une hauteur `midi` (réel). key < 0 : chromatique ; sinon tonique 0 (Do) … 11 (Si).
// Hystérésis de 15 cents : on garde la note précédente tant qu'une autre n'est pas nettement plus proche.
export function scaleNote(midi, key = -1, minor = false, prev = null) {
  const sc = minor ? SCALES.minor : SCALES.major;
  const ok = n => key < 0 || sc.includes((((n - key) % 12) + 12) % 12);
  let best = Math.round(midi), bd = Infinity;
  for (let n = Math.floor(midi) - 2; n <= Math.ceil(midi) + 2; n++) if (ok(n)) { const d = Math.abs(n - midi); if (d < bd) { bd = d; best = n; } }
  if (prev !== null && ok(prev) && Math.abs(prev - midi) <= bd + 0.15) return prev;
  return best;
}

function lowpass(sr, f, q) {
  const w = 2 * Math.PI * f / sr, al = Math.sin(w) / (2 * q), c = Math.cos(w), a0 = 1 + al;
  return { b0: (1 - c) / 2 / a0, b1: (1 - c) / a0, b2: (1 - c) / 2 / a0, a1: -2 * c / a0, a2: (1 - al) / a0, z1: 0, z2: 0 };
}

export class AutoTune {
  constructor(sr, o = {}) {
    this.sr = sr; this.L = tuneLatency(sr);
    this.dec = Math.max(1, Math.round(sr / 12000)); this.dsr = sr / this.dec;
    this.tauMin = Math.max(2, Math.floor(this.dsr / (TUNE.fmax * 1.15))); this.tauMax = Math.ceil(this.dsr / (TUNE.fmin * 0.9));
    this.W = Math.ceil(this.dsr * TUNE.windowMs / 1000);
    this.F = this.W + this.tauMax + 2;
    this.frame = new Float32Array(this.F); this.dfn = new Float32Array(this.tauMax + 2);
    let dn = 1; while (dn < this.F * 2) dn <<= 1; this.dbuf = new Float32Array(dn); this.dmask = dn - 1; this.dw = 0; this.dph = 0;
    const fc = Math.min(2600, this.dsr * 0.42);
    this.lp1 = lowpass(sr, fc, 0.5412); this.lp2 = lowpass(sr, fc, 1.3066); // Butterworth d'ordre 4 (anti-repliement)
    let n = 1; while (n < 2 * this.L + this.F * this.dec + 4 * this.dec + 64) n <<= 1; this.xb = new Float32Array(n); this.mask = n - 1; this.w = 0;
    this.hop = this.dec * Math.max(8, Math.round(this.dsr * TUNE.hopMs / 1000)); this.hc = 0;
    this.Dt = sr * TUNE.spanMs / 1000; this.Dmax = 2 * (this.L - 3); this.D = Math.min(this.Dt, this.Dmax); this.Dgoal = this.D; this.m = 0;
    this.p = 0.5; this.corr = 0; this.corrGoal = 0; this.vm = 0; this.voiced = false; this.quiet = 1e9;
    this.kv = 1 - Math.exp(-1 / (sr * 0.006)); this.kD = 1 - Math.exp(-1 / (sr * 0.03)); this.ke = 1 - Math.exp(-1 / (sr * 0.02));
    this.env = 0; this.target = null; this.f0 = 0; this.midi = 0; this.aper = 1; this.lastVoiced = -1e9; this.t = 0;
    this.set({ ...TUNE_DEFAULTS, ...o });
  }
  set(o = {}) {
    if (Number.isFinite(o.tuneSpeed)) this.speed = Math.min(100, Math.max(0, o.tuneSpeed));
    if (Number.isInteger(o.tuneKey) && o.tuneKey >= -1 && o.tuneKey <= 11) this.key = o.tuneKey;
    if (typeof o.tuneMinor === 'boolean') this.minor = o.tuneMinor;
    const tau = speedTau(this.speed);
    this.kc = tau <= 0 ? 1 : 1 - Math.exp(-1 / (this.sr * tau));
    this.target = null;
  }
  get latency() { return this.L; }
  // Lecture fractionnaire (Hermite 4 points) à `d` échantillons dans le passé.
  read(d) {
    const pos = this.w - d, i = Math.floor(pos), f = pos - i, b = this.xb, m = this.mask;
    const xm1 = b[(i - 1) & m], x0 = b[i & m], x1 = b[(i + 1) & m], x2 = b[(i + 2) & m];
    const c1 = 0.5 * (x1 - xm1), c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
    return ((c3 * f + c2) * f + c1) * f + x0;
  }
  process(x, y) {
    const { xb, mask, L, dbuf, dmask, dec, lp1, lp2 } = this;
    for (let i = 0; i < x.length; i++) {
      const s = x[i];
      xb[this.w] = s;
      this.env += this.ke * (s * s - this.env);
      // filtre anti-repliement puis décimation (analyse à ~12 kHz)
      let v = lp1.b0 * s + lp1.z1; lp1.z1 = lp1.b1 * s - lp1.a1 * v + lp1.z2; lp1.z2 = lp1.b2 * s - lp1.a2 * v;
      const u = lp2.b0 * v + lp2.z1; lp2.z1 = lp2.b1 * v - lp2.a1 * u + lp2.z2; lp2.z2 = lp2.b2 * v - lp2.a2 * u;
      if (++this.dph >= dec) { this.dph = 0; dbuf[this.dw] = u; this.dw = (this.dw + 1) & dmask; }
      if (++this.hc >= this.hop) { this.hc = 0; this.analyse(); }
      this.vm += this.kv * ((this.voiced ? 1 : 0) - this.vm);
      const dry = xb[(this.w - L) & mask];
      let out;
      if (!this.voiced && this.vm < 1e-4) { this.vm = 0; this.p = 0.5; out = dry; } // hors voix : entrée intacte (retardée)
      else {
        this.corr += this.kc * (this.corrGoal - this.corr);
        this.D += this.kD * (this.Dgoal - this.D);
        const r = Math.exp(this.corr * 5.776226504666211e-4); // 2^(cents/1200)
        let p = this.p + (1 - r) / this.D; p -= Math.floor(p); this.p = p;
        const pB = p < 0.5 ? p + 0.5 : p - 0.5;
        const wA = 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
        const sh = wA * this.read(L + (p - 0.5) * this.D) + (1 - wA) * this.read(L + (pB - 0.5) * this.D);
        out = dry + this.vm * (sh - dry);
      }
      y[i] = out;
      this.w = (this.w + 1) & mask; this.t++;
    }
  }
  // Une analyse : niveau, YIN, affinage, note cible, écart des têtes.
  analyse() {
    const levelDb = 10 * Math.log10(this.env + 1e-20);
    if (levelDb < TUNE.gateDb) return this.unvoiced();
    const { frame, dfn, W, tauMax, tauMin, dbuf, dmask, F } = this;
    const st = (this.dw - F) & dmask;
    for (let j = 0; j < F; j++) frame[j] = dbuf[(st + j) & dmask];
    let sum = 0; dfn[0] = 1;
    for (let tau = 1; tau <= tauMax; tau++) {
      let d = 0; for (let j = 0; j < W; j++) { const e = frame[j] - frame[j + tau]; d += e * e; }
      sum += d; dfn[tau] = sum > 0 ? d * tau / sum : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) if (dfn[t] < TUNE.yin) { while (t + 1 <= tauMax && dfn[t + 1] < dfn[t]) t++; tau = t; break; }
    if (tau < 0) { let b = tauMin; for (let t = tauMin; t <= tauMax; t++) if (dfn[t] < dfn[b]) b = t; tau = b; }
    this.aper = dfn[tau];
    if (this.aper > TUNE.voiced || tau <= tauMin || tau >= tauMax) return this.unvoiced();
    const a = dfn[tau - 1], b = dfn[tau], c = dfn[tau + 1], den = a - 2 * b + c;
    const td = tau + (den > 0 ? 0.5 * (a - c) / den : 0);
    const P = this.refine(td * this.dec);
    const f0 = this.sr / P;
    if (!(f0 >= TUNE.fmin * 0.95 && f0 <= TUNE.fmax * 1.05)) return this.unvoiced();
    const onset = !this.voiced && this.t - this.lastVoiced > this.sr * 0.06;
    this.f0 = f0; this.midi = hzToMidi(f0);
    this.target = scaleNote(this.midi, this.key, this.minor, onset ? null : this.target);
    this.corrGoal = (this.target - this.midi) * 100;
    if (onset) this.corr = this.kc >= 1 ? this.corrGoal : 0;
    // écart des têtes = 2·m périodes, proche de spanMs (hystérésis pour ne pas changer de m sans arrêt)
    const T2 = 2 * P; let m = this.m, Dc = T2 * m;
    if (!m || Dc < this.Dt * 0.66 || Dc > this.Dt * 1.6 || Dc > this.Dmax) { m = Math.max(1, Math.round(this.Dt / T2)); while (m > 1 && T2 * m > this.Dmax) m--; }
    this.m = m; this.Dgoal = Math.min(T2 * m, this.Dmax);
    if (this.vm < 0.01) this.D = this.Dgoal; // départ : têtes alignées sur l'entrée, on peut changer l'écart sans saut
    this.voiced = true; this.lastVoiced = this.t;
  }
  unvoiced() { this.voiced = false; }
  // Différence carrée à pleine fréquence autour de la période estimée, puis interpolation parabolique.
  refine(P0) {
    if (this.dec === 1) return P0;
    const { xb, mask, dec } = this, Wf = this.W * dec;
    const k0 = Math.max(2, Math.floor(P0) - dec), k1 = Math.ceil(P0) + dec, a0 = this.w - (Wf + k1);
    let best = k0, bv = Infinity; const vals = [];
    for (let k = k0; k <= k1; k++) {
      let d = 0; for (let j = 0; j < Wf; j++) { const e = xb[(a0 + j) & mask] - xb[(a0 + j + k) & mask]; d += e * e; }
      vals.push(d); if (d < bv) { bv = d; best = k; }
    }
    const i = best - k0; if (i <= 0 || i >= vals.length - 1) return best;
    const a = vals[i - 1], b = vals[i], c = vals[i + 1], den = a - 2 * b + c;
    return best + (den > 0 ? 0.5 * (a - c) / den : 0);
  }
  // État affiché : note chantée, note visée, correction appliquée (cents).
  info() {
    const v = this.voiced;
    return { voiced: v, hz: v ? +this.f0.toFixed(1) : 0, note: v ? noteName(this.midi) : '', target: v && this.target !== null ? noteName(this.target) : '',
      cents: v ? Math.round(this.corr) : 0, sung: v ? Math.round((this.midi - Math.round(this.midi)) * 100) : 0 };
  }
}
