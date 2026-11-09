// AudioWorklet du dé-esseur (traitement dans dsp.js, partagé avec les tests unitaires). Chargé séparément de
// worklets.js : s'il échouait sur un navigateur, seul le dé-esseur serait indisponible, pas le son.
import { Deesser } from './dsp.js';

// Renvoie toutes les ~250 ms l'atténuation maximale (dB).
class CcDeesser extends AudioWorkletProcessor {
  constructor() { super(); this.d = new Deesser(sampleRate); this.n = 0; }
  process(inputs, outputs) {
    const x = inputs[0] && inputs[0][0], y = outputs[0][0];
    if (!y) return true;
    if (!x) { y.fill(0); return true; }
    this.d.process(x, y);
    if ((this.n += x.length) >= sampleRate / 4) { this.n = 0; this.port.postMessage(this.d.takeReduction()); }
    return true;
  }
}
registerProcessor('cc-deesser', CcDeesser);
