// AudioWorklet de l'isolateur de voix (1.9). Le module WebAssembly de DeepFilterNet3 est compilé par la page
// (téléchargé une seule fois, à la demande) et transmis ici ; à défaut (navigateur qui ne transmet pas de module
// compilé), on reçoit les octets et on compile sur place. Tant que le modèle n'est pas prêt, le son passe tel quel.
import { dfInit } from './df-glue.js';
import { IsoStream, ISO } from './isolateur.js';

class CcIsolateur extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.s = null; this.busy = 0; this.win = 0; this.over = 0; this.n = 0;
    try {
      const t0 = Date.now();
      const mod = o.module || new WebAssembly.Module(o.bytes);
      const g = dfInit(mod), st = g.create(100);
      if (g.frameLength(st) !== ISO.frame) throw new Error('trame inattendue ' + g.frameLength(st));
      this.s = new IsoStream(sampleRate, { process: x => g.process(st, x), setAttenLim: d => g.setAttenLim(st, d) }, o.isoLevel);
      this.port.postMessage({ type: 'ready', ms: Date.now() - t0 });
    } catch (e) { this.port.postMessage({ type: 'error', message: String(e?.message || e) }); }
    this.port.onmessage = e => { if (typeof e.data?.isoLevel === 'number') this.s?.set(e.data.isoLevel); };
  }
  process(inputs, outputs) {
    const x = inputs[0] && inputs[0][0], y = outputs[0] && outputs[0][0];
    if (!y) return true;
    if (!this.s) { if (x) y.set(x); else y.fill(0); return true; }
    const t0 = Date.now();
    this.s.process(x || new Float32Array(y.length), y);
    // charge : temps de calcul / durée du son, par fenêtres de 2 s ; au-delà de 85 % deux fois de suite, l'appareil
    // est jugé trop lent : on repasse au son direct (même latence) et la page l'indique.
    this.busy += Date.now() - t0; this.win += y.length;
    if (this.win >= 2 * sampleRate) {
      const load = this.busy / (this.win / sampleRate * 1000);
      this.over = load > ISO.maxLoad && !this.s.bypass ? this.over + 1 : 0;
      if (this.over >= 2) { this.s.bypass = true; this.port.postMessage({ type: 'surcharge', load }); }
      this.load = load; this.busy = 0; this.win = 0;
    }
    if ((this.n += y.length) >= sampleRate / 4) { this.n = 0; this.port.postMessage({ type: 'info', gateDb: this.s.gate.takeReduction(), load: this.load ?? null, underruns: this.s.underruns, bypass: this.s.bypass }); }
    return true;
  }
}
registerProcessor('cc-isolateur', CcIsolateur);
