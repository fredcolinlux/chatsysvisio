// IMA ADPCM 4 bits (mono, 16 kHz) : repli audio universel quand WebCodecs/Opus est absent
// (iPhone < iOS 26, vieux navigateurs). 20 ms = 320 échantillons -> 4 + 160 octets (~66 kbit/s).
const STEP = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
const IDX = [-1,-1,-1,-1,2,4,6,8,-1,-1,-1,-1,2,4,6,8];
export const ADPCM_RATE = 16000;

export class AdpcmEncoder {
  constructor() { this.pred = 0; this.index = 0; }
  // samples : Float32Array (-1..1), longueur paire
  encode(samples) {
    const n = samples.length, out = new Uint8Array(4 + (n >> 1));
    const dv = new DataView(out.buffer);
    dv.setInt16(0, this.pred, true); out[2] = this.index; out[3] = 0;
    let pred = this.pred, index = this.index;
    for (let i = 0; i < n; i++) {
      const s = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
      let step = STEP[index], diff = s - pred, code = 0;
      if (diff < 0) { code = 8; diff = -diff; }
      let delta = step >> 3;
      if (diff >= step) { code |= 4; diff -= step; delta += step; }
      step >>= 1; if (diff >= step) { code |= 2; diff -= step; delta += step; }
      step >>= 1; if (diff >= step) { code |= 1; delta += step; }
      pred += (code & 8) ? -delta : delta;
      pred = Math.max(-32768, Math.min(32767, pred));
      index = Math.max(0, Math.min(88, index + IDX[code]));
      if (i & 1) out[4 + (i >> 1)] |= code << 4; else out[4 + (i >> 1)] = code;
    }
    this.pred = pred; this.index = index;
    return out;
  }
}

export function adpcmDecode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 5) return new Float32Array(0);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let pred = dv.getInt16(0, true), index = Math.min(88, u8[2]);
  const n = (u8.length - 4) * 2, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const b = u8[4 + (i >> 1)], code = (i & 1) ? b >> 4 : b & 15;
    const step = STEP[index];
    let delta = step >> 3;
    if (code & 4) delta += step; if (code & 2) delta += step >> 1; if (code & 1) delta += step >> 2;
    pred += (code & 8) ? -delta : delta;
    pred = Math.max(-32768, Math.min(32767, pred));
    index = Math.max(0, Math.min(88, index + IDX[code]));
    out[i] = pred / 32768;
  }
  return out;
}

// Rééchantillonneur linéaire avec état (flux continu).
export class Resampler {
  constructor(from, to) { this.r = from / to; this.pos = 0; this.last = 0; }
  process(input) {
    const out = [];
    let pos = this.pos;
    while (pos < input.length) {
      const i = Math.floor(pos), f = pos - i;
      const a = i - 1 < 0 ? this.last : input[i - 1], b = input[i];
      out.push(a + (b - a) * f);
      pos += this.r;
    }
    this.pos = pos - input.length;
    if (input.length) this.last = input[input.length - 1];
    return Float32Array.from(out);
  }
}

export function rmsLevel(samples) {
  let s = 0; for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  const rms = Math.sqrt(s / Math.max(1, samples.length));
  // échelle perceptive 0..255 (≈ -60 dBFS .. 0 dBFS)
  const db = 20 * Math.log10(rms + 1e-9);
  return Math.max(0, Math.min(255, Math.round((db + 60) / 60 * 255)));
}
