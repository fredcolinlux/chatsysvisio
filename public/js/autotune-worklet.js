// AudioWorklet de l'autotune (traitement dans autotune.js, partagé avec les tests unitaires). Module séparé : s'il
// échouait sur un navigateur, seul l'autotune serait indisponible, pas le son.
import { AutoTune } from './autotune.js';

// Réglages reçus par le port (vitesse, tonalité, mode) ; renvoie ~10 fois par seconde la note détectée et la correction.
class CcAutotune extends AudioWorkletProcessor {
  constructor(o) {
    super(); this.a = new AutoTune(sampleRate, o?.processorOptions || {}); this.n = 0; this.zero = new Float32Array(128);
    this.port.onmessage = e => { if (e.data && typeof e.data === 'object') this.a.set(e.data); };
  }
  process(inputs, outputs) {
    const y = outputs[0][0]; if (!y) return true;
    let x = inputs[0] && inputs[0][0];
    if (!x) { if (this.zero.length !== y.length) this.zero = new Float32Array(y.length); x = this.zero; }
    this.a.process(x, y);
    if ((this.n += y.length) >= sampleRate / 10) { this.n = 0; this.port.postMessage(this.a.info()); }
    return true;
  }
}
registerProcessor('cc-autotune', CcAutotune);
