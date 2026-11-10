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
