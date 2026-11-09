// Chaîne de traitement du micro (Web Audio), entre la source getUserMedia et la capture vers l'encodeur Opus :
//   source → [réduction de bruit RNNoise] → [compresseur + gain de compensation] → [dé-esseur] → capture
// Chaque étage s'active ou se coupe à chaud (recâblage des nœuds, sans toucher au micro ni à l'appel).
import { COMPRESSOR, COMPRESSOR_MAKEUP_DB, FX_DEFAULTS, parseFx } from './dsp.js';

export const FX_KEY = 'csv-micfx';
export const loadFx = (st = globalThis.localStorage) => parseFx(st?.getItem(FX_KEY));
export const saveFx = (fx, st = globalThis.localStorage) => { try { st?.setItem(FX_KEY, JSON.stringify(fx)); } catch {} };

const RN_DIR = '/vendor/rnnoise/';
const RN_PROC = '@sapphi-red/web-noise-suppressor/rnnoise';
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
let rnBinary = null; // binaire wasm, téléchargé une fois par page (≈ 150 ko, servi par ton serveur)
const rnModules = new WeakMap(); // contexte → module du worklet RNNoise chargé
const deModules = new WeakMap(); // contexte → module du dé-esseur chargé

export function noiseSuppressionSupported() {
  return typeof WebAssembly === 'object' && typeof AudioWorkletNode === 'function';
}
async function rnnoiseNode(ctx) {
  if (!noiseSuppressionSupported()) throw new Error('AudioWorklet ou WebAssembly indisponible');
  rnBinary ||= (async () => {
    let simd = false; try { simd = WebAssembly.validate(SIMD_PROBE); } catch {}
    const r = await fetch(RN_DIR + (simd ? 'rnnoise_simd.wasm' : 'rnnoise.wasm'));
    if (!r.ok) throw new Error('rnnoise.wasm ' + r.status);
    return { buf: await r.arrayBuffer(), simd };
  })().catch(e => { rnBinary = null; throw e; });
  const { buf, simd } = await rnBinary;
  if (!rnModules.has(ctx)) rnModules.set(ctx, ctx.audioWorklet.addModule(RN_DIR + 'rnnoise-worklet.js').catch(e => { rnModules.delete(ctx); throw e; }));
  await rnModules.get(ctx);
  const node = new AudioWorkletNode(ctx, RN_PROC, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
    processorOptions: { maxChannels: 1, wasmBinary: buf.slice(0) } });
  node.simd = simd;
  return node;
}

export class MicChain {
  // ctx : AudioContext ou OfflineAudioContext (tests). Les worklets RNNoise et dé-esseur sont chargés à la demande.
  constructor(ctx) {
    this.ctx = ctx; this.fx = { ...FX_DEFAULTS };
    this.input = ctx.createGain(); this.output = ctx.createGain();
    this.status = { ns: 'off', comp: 'off', deess: 'off' };
    this.deessDb = 0; this.nsInfo = '';
    this.comp = ctx.createDynamicsCompressor();
    for (const [k, v] of Object.entries(COMPRESSOR)) this.comp[k].value = v;
    this.makeup = ctx.createGain(); this.makeup.gain.value = Math.pow(10, COMPRESSOR_MAKEUP_DB / 20);
    this.comp.connect(this.makeup);
    this.de = null; this.deError = null; this.ns = null; this.nsLoading = null; this.seq = 0;
    this.wire();
  }
  // Applique les trois interrupteurs. Renvoie l'état effectif ({ ns, comp, deess } : 'on' | 'off' | 'indisponible').
  async set(fx) {
    this.fx = { ...FX_DEFAULTS, ...fx }; const my = ++this.seq;
    this.wire(); // compresseur : immédiat
    if (this.fx.deess && !this.de && !this.deError) {
      try {
        if (!deModules.has(this.ctx)) deModules.set(this.ctx, this.ctx.audioWorklet.addModule('/js/deesser-worklet.js'));
        await deModules.get(this.ctx);
        if (!this.de) {
          this.de = new AudioWorkletNode(this.ctx, 'cc-deesser', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' });
          this.de.port.onmessage = e => { this.deessDb = e.data; };
        }
      } catch (e) { this.deError = String(e?.message || e); }
      if (my === this.seq) this.wire();
    }
    if (this.fx.ns && !this.ns && !this.nsError) {
      try {
        this.nsLoading ||= rnnoiseNode(this.ctx);
        this.wire();
        const node = await this.nsLoading;
        this.ns ||= node;
        if (this.ctx.sampleRate !== 48000) this.nsInfo = `RNNoise est conçu pour 48 kHz ; ton navigateur tourne à ${this.ctx.sampleRate / 1000} kHz (effet un peu moindre).`;
      } catch (e) { this.nsError = String(e?.message || e); }
      this.nsLoading = null;
      if (my === this.seq) this.wire(); // sinon un réglage plus récent recâble lui-même
    }
    return this.status;
  }
  wire() {
    const all = [this.input, this.ns, this.comp, this.makeup, this.de].filter(Boolean);
    for (const n of all) { if (n === this.comp) continue; try { n.disconnect(); } catch {} }
    const stages = [];
    if (this.fx.ns && this.ns) stages.push([this.ns, this.ns]);
    if (this.fx.comp) stages.push([this.comp, this.makeup]);
    if (this.fx.deess && this.de) stages.push([this.de, this.de]);
    let last = this.input;
    for (const [a, b] of stages) { last.connect(a); last = b; }
    last.connect(this.output);
    this.status.ns = this.nsError ? 'indisponible' : !this.fx.ns ? 'off' : this.ns ? 'on' : 'chargement';
    this.status.comp = this.fx.comp ? 'on' : 'off';
    this.status.deess = this.deError ? 'indisponible' : !this.fx.deess ? 'off' : this.de ? 'on' : 'chargement';
  }
  // Réduction de gain en cours (dB, valeurs positives) : affichage « en direct » sous les interrupteurs.
  meters() { return { comp: this.fx.comp ? Math.max(0, -(this.comp.reduction?.value ?? this.comp.reduction ?? 0)) : 0, deess: this.fx.deess ? this.deessDb : 0 }; }
  dispose() {
    for (const n of [this.input, this.ns, this.comp, this.makeup, this.de, this.output]) { try { n?.disconnect(); } catch {} }
    try { this.ns?.port.postMessage('destroy'); } catch {}
  }
}
