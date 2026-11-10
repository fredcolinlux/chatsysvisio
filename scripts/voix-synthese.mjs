// Voix chantée de synthèse (aucun enregistrement, aucun droit) : source glottique riche en harmoniques, formants
// d'une voyelle « a », vibrato, légère dérive de justesse. Sert aux tests et à l'extrait de démonstration.
export function singer(sr, notes, { cents = [], vibrato = 18, breath = 0.004, gap = 0.06, seed = 3 } = {}) {
  // notes : [[midi, durée en s], …] ; cents : écart de justesse volontaire par note (chanteur un peu faux)
  const total = notes.reduce((a, [, d]) => a + d, 0), n = Math.round(total * sr), y = new Float32Array(n);
  const res = (f, bw) => { const r = Math.exp(-Math.PI * bw / sr), w = 2 * Math.PI * f / sr; return { a1: -2 * r * Math.cos(w), a2: r * r, g: 1 - r, y1: 0, y2: 0 }; };
  const F = [res(800, 80), res(1150, 90), res(2900, 120)], G = [1, 0.5, 0.12];
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 * 2 - 1;
  let ph = 0, i0 = 0;
  notes.forEach(([midi, dur], k) => {
    const len = Math.round(dur * sr), off = cents[k] || 0;
    for (let i = 0; i < len && i0 + i < n; i++) {
      const t = i / sr, att = Math.min(1, t / 0.04, (dur - gap - t) / 0.04);
      const env = Math.max(0, att);
      const drift = off + 12 * Math.sin(2 * Math.PI * 0.7 * t + k); // dérive lente
      const vib = vibrato * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.3);
      const f = 440 * 2 ** ((midi - 69 + (drift + vib) / 100) / 12);
      ph += f / sr; ph -= Math.floor(ph);
      const src = (2 * ph - 1) * -1 + 0.0; // dent de scie (toutes les harmoniques)
      let v = 0; const e = src * env + breath * rnd() * env;
      for (let j = 0; j < 3; j++) { const r = F[j], o = r.g * e - r.a1 * r.y1 - r.a2 * r.y2; r.y2 = r.y1; r.y1 = o; v += G[j] * o; }
      y[i0 + i] = v;
    }
    i0 += len;
  });
  let pk = 0; for (const v of y) pk = Math.max(pk, Math.abs(v)); for (let i = 0; i < n; i++) y[i] *= 0.5 / pk;
  return y;
}
export function wav16(samples, sr) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return b;
}

// ---- Parole de synthèse (1.9) : synthèse par formants à la Klatt, sans enregistrement ni droit ----
// Syllabes consonne + voyelle, transitions de formants, intonation (déclinaison + accents), fricatives et occlusives.
const VOY = { a: [730, 1250, 2550], e: [480, 1750, 2600], é: [420, 2050, 2700], i: [290, 2250, 3000], o: [450, 850, 2550], ou: [320, 780, 2300], u: [300, 1800, 2200], on: [470, 900, 2500] };
const CONS = { s: ['fric', 4500, 6500], ch: ['fric', 2300, 4200], f: ['fric', 1500, 7000], t: ['occl', 3500, 6000], k: ['occl', 1800, 3000], p: ['occl', 700, 1500], m: ['nas', 250, 1000], n: ['nas', 250, 1600], l: ['liq', 360, 1300], r: ['liq', 500, 1400], b: ['vocc', 600, 1200], d: ['vocc', 1700, 2800] };
export function parole(sr, sec, { f0 = 115, seed = 7, level = 0.35, rate = 4.6, pauses = true } = {}) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const n = Math.round(sec * sr), y = new Float32Array(n);
  const vk = Object.keys(VOY), ck = Object.keys(CONS);
  // plan : suite de syllabes, groupes de 4 à 9 séparés de pauses (respirations)
  const syl = []; let t = 0.15;
  while (t < sec - 0.3) {
    const k = 4 + Math.floor(rnd() * 6);
    for (let j = 0; j < k && t < sec - 0.3; j++) { const d = (0.75 + 0.5 * rnd()) / rate; syl.push({ t, d, v: vk[Math.floor(rnd() * vk.length)], c: rnd() < 0.85 ? ck[Math.floor(rnd() * ck.length)] : null, acc: j === k - 1 || rnd() < 0.2, g: j / k }); t += d; }
    t += pauses ? 0.25 + 0.35 * rnd() : 0.04;
  }
  const res = () => ({ y1: 0, y2: 0 });
  const R = [res(), res(), res(), res()], BW = [70, 100, 140, 200];
  const step = (r, x, f, bw) => { const rr = Math.exp(-Math.PI * bw / sr), a1 = -2 * rr * Math.cos(2 * Math.PI * f / sr), a2 = rr * rr, o = (1 + a1 + a2) * x - a1 * r.y1 - a2 * r.y2; r.y2 = r.y1; r.y1 = o; return o; };
  const fr = [res(), res()];
  let ph = 0, lp = 0, si = 0, jit = 0;
  for (let i = 0; i < n; i++) {
    const tt = i / sr;
    while (si < syl.length - 1 && tt >= syl[si + 1].t) si++;
    const S = syl[si], u = (tt - S.t) / S.d; // position dans la syllabe 0..1
    if (!S || u < 0 || u > 1.0) { y[i] = 0; continue; }
    const C = S.c ? CONS[S.c] : null, cEnd = C ? 0.28 : 0; // part consonantique
    const prev = syl[si - 1] && syl[si - 1].t + syl[si - 1].d > S.t - 0.01 ? VOY[syl[si - 1].v] : VOY[S.v];
    const tgt = VOY[S.v], m = Math.min(1, Math.max(0, (u - cEnd * 0.6) / 0.35)); // transition des formants
    const F = tgt.map((f, k) => prev[k] + (f - prev[k]) * (m * m * (3 - 2 * m)));
    // intonation : déclinaison sur le groupe, accent en fin de groupe, micro-variations
    if ((i & 63) === 0) jit = 0.985 + 0.03 * rnd();
    const pitch = f0 * (1.12 - 0.22 * S.g) * (S.acc ? 1 + 0.18 * Math.sin(Math.PI * u) : 1) * jit;
    ph += pitch / sr; let pulse = 0; if (ph >= 1) { ph -= 1; pulse = 1; }
    // source glottique : impulsions filtrées (pente spectrale −12 dB/oct environ)
    lp = 0.97 * lp + pulse; const glot = lp - 0.5 * (lp > 0 ? 1 : 0) * 0;
    let env = Math.min(1, u / 0.06, (1 - u) / 0.12); env = Math.max(0, env);
    let voiced = 1, nz = 0;
    if (C && u < cEnd) {
      const cu = u / cEnd, type = C[0];
      if (type === 'fric') { voiced = 0.05; nz = 0.9 * Math.min(1, cu / 0.2, (1 - cu) / 0.2); }
      else if (type === 'occl') { voiced = 0; nz = cu > 0.75 ? 1.4 * Math.exp(-(cu - 0.75) * 30) : 0; }
      else if (type === 'vocc') { voiced = cu > 0.7 ? 1 : 0.15; nz = cu > 0.7 && cu < 0.8 ? 0.8 : 0; }
      else if (type === 'nas') { voiced = 0.55; }
      else { voiced = 0.8; }
    }
    // voyelle : cascade de 4 formants
    let v = glot * 0.9 + 0.01 * (rnd() * 2 - 1);
    v *= voiced;
    let out = 0, xx = v;
    for (let k = 0; k < 4; k++) { const f = k < 3 ? (C && C[0] === 'nas' && u < cEnd && k === 0 ? C[1] : F[k]) : 3500; xx = step(R[k], xx, f, BW[k]); }
    out = xx;
    if (nz) { const w = rnd() * 2 - 1; let b = step(fr[0], w, C[1], C[2] - C[1]); b = step(fr[1], b, C[2], (C[2] - C[1]) * 1.2); out += nz * b * 0.6; }
    y[i] = out * env;
  }
  // normalisation sur le niveau RMS des parties actives
  let e = 0, c = 0; for (const v of y) if (Math.abs(v) > 1e-4) { e += v * v; c++; }
  const g = level / Math.sqrt(e / Math.max(1, c)) * 0.3; for (let i = 0; i < n; i++) y[i] *= g;
  return y;
}

// ---- Musique de synthèse (1.9) : accords, basse, batterie ; aucun échantillon ni mélodie existante ----
export function musique(sr, sec, { seed = 11, level = 0.25, bpm = 104 } = {}) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const n = Math.round(sec * sr), y = new Float32Array(n), beat = 60 / bpm;
  const prog = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // la m, fa, do, sol
  const hz = m => 440 * 2 ** ((m - 69) / 12);
  for (let i = 0; i < n; i++) {
    const t = i / sr, bar = Math.floor(t / (4 * beat)), ch = prog[bar % 4], tb = t % beat, b8 = t % (beat / 2), bi = Math.floor(t / beat) % 4;
    let v = 0;
    // nappe : 3 notes, dents de scie douces (4 harmoniques), légèrement désaccordées
    for (const m of ch) for (const det of [-0.08, 0.08]) { const f = hz(m + 12 + det); for (let h = 1; h <= 4; h++) v += 0.045 / h * Math.sin(2 * Math.PI * f * h * t); }
    // arpège pincé
    const an = ch[Math.floor(t / (beat / 2)) % 3] + 24, ae = Math.exp(-b8 * 9);
    v += 0.12 * ae * (Math.sin(2 * Math.PI * hz(an) * t) + 0.3 * Math.sin(4 * Math.PI * hz(an) * t));
    // basse
    v += 0.22 * Math.exp(-tb * 3) * Math.sin(2 * Math.PI * hz(ch[0] - 12) * t);
    // grosse caisse (temps 1 et 3), caisse claire (2 et 4), charleston (croches)
    if (bi % 2 === 0) v += 0.5 * Math.exp(-tb * 28) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-tb * 40)) * tb);
    else v += 0.25 * Math.exp(-tb * 22) * (rnd() * 2 - 1);
    v += 0.05 * Math.exp(-b8 * 60) * (rnd() * 2 - 1);
    y[i] = v;
  }
  let e = 0; for (const v of y) e += v * v; const g = level / Math.sqrt(e / n); for (let i = 0; i < n; i++) y[i] *= g;
  return y;
}

// Pièce réverbérante simple (voix « lointaine ») : filtrage passe-bande + réverbération à décroissance exponentielle.
export function lointain(sr, x, { gainDb = -16, rt60 = 0.6, seed = 5 } = {}) {
  let s = seed; const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647 * 2 - 1;
  const L = Math.round(rt60 * sr), ir = new Float32Array(L);
  for (let i = 0; i < L; i++) ir[i] = rnd() * Math.exp(-6.9 * i / L) * (i < sr * 0.004 ? 0 : 1);
  ir[0] = 0.35; // trajet direct faible : on est loin
  // convolution par blocs (FFT inutile ici : sous-échantillonnage de la réponse)
  const y = new Float32Array(x.length), taps = [];
  for (let i = 0; i < L; i += 1) if (i === 0 || (i % 7 === 0)) taps.push([i, ir[i] * (i ? 0.05 : 1)]);
  for (const [d, g] of taps) for (let i = d; i < x.length; i++) y[i] += g * x[i - d];
  let lp = 0, hp = 0, hpx = 0; for (let i = 0; i < y.length; i++) { lp += 0.35 * (y[i] - lp); hp = 0.98 * (hp + lp - hpx); hpx = lp; y[i] = hp; }
  let ex = 0, ey = 0; for (let i = 0; i < x.length; i++) { ex += x[i] * x[i]; ey += y[i] * y[i]; }
  const g = Math.sqrt(ex / Math.max(1e-12, ey)) * 10 ** (gainDb / 20); for (let i = 0; i < y.length; i++) y[i] *= g;
  return y;
}
