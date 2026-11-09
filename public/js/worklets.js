// AudioWorklets : capture du micro par blocs de 20 ms, et lecteur avec tampon de gigue par participant.
// (Sans import : ce module doit se charger partout. Le dé-esseur est à part, dans deesser-worklet.js.)
class CcCapture extends AudioWorkletProcessor {
  constructor() { super(); this.size = Math.round(sampleRate * 0.02); this.buf = new Float32Array(this.size); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.size) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('cc-capture', CcCapture);

class CcPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = new Map();
    this.start = sampleRate * 0.06;   // démarre la lecture avec 60 ms d'avance
    this.max = sampleRate * 0.28;     // au-delà de 280 ms de retard : on rattrape
    this.keep = sampleRate * 0.08;
    this.port.onmessage = e => {
      const { sid, pcm, clear } = e.data;
      if (clear !== undefined) { this.q.delete(clear); return; }
      let s = this.q.get(sid);
      if (!s) { s = { chunks: [], off: 0, len: 0, playing: false }; this.q.set(sid, s); }
      s.chunks.push(pcm); s.len += pcm.length;
      if (s.len - s.off > this.max) {
        while (s.chunks.length > 1 && s.len - s.off > this.keep) { const c = s.chunks.shift(); s.len -= c.length; s.off = 0; }
      }
    };
  }
  process(_, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    out.fill(0);
    for (const s of this.q.values()) {
      if (!s.playing) { if (s.len - s.off >= this.start) s.playing = true; else continue; }
      let i = 0;
      while (i < out.length && s.chunks.length) {
        const c = s.chunks[0], take = Math.min(out.length - i, c.length - s.off);
        for (let k = 0; k < take; k++) out[i + k] += c[s.off + k];
        i += take; s.off += take;
        if (s.off >= c.length) { s.chunks.shift(); s.len -= c.length; s.off = 0; }
      }
      if (i < out.length) s.playing = false; // sous-alimentation : on attend de nouveau un peu de tampon
    }
    for (let i = 0; i < out.length; i++) { const x = out[i]; out[i] = x > 1 ? 1 : x < -1 ? -1 : x; }
    for (let c = 1; c < outputs[0].length; c++) outputs[0][c].set(out);
    return true;
  }
}
registerProcessor('cc-player', CcPlayer);

