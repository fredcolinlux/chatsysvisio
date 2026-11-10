// Chaîne de traitement du micro (Web Audio), entre la source getUserMedia et la capture vers l'encodeur Opus :
//   source → [isolateur de voix DeepFilterNet3 | réduction de bruit RNNoise] → [autotune] → [compresseur + gain de
//   compensation] → [dé-esseur] → capture
// L'isolateur (1.9) prend la place de RNNoise : c'est aussi une réduction de bruit, en plus profond (musique, télé,
// bruits forts). Les deux ensemble seraient un double traitement (latence et artefacts en plus, aucun gain) : quand
// l'isolateur tourne, RNNoise est mis en pause (état « inclus ») ; il reprend si l'isolateur est coupé ou en défaut.
// L'autotune vient après la réduction de bruit (hauteur détectée sur une voix propre, moins de faux départs) et avant
// le compresseur (dont les variations de gain ne gênent pas la détection, et qui égalise ensuite le niveau).
// Chaque étage s'active ou se coupe à chaud (recâblage des nœuds, sans toucher au micro ni à l'appel).
import { COMPRESSOR, COMPRESSOR_MAKEUP_DB, FX_DEFAULTS, parseFx } from './dsp.js';
import { tuneLatency } from './autotune.js';
import { isoLatency } from './isolateur.js';

export const FX_KEY = 'csv-micfx';
export const loadFx = (st = globalThis.localStorage) => parseFx(st?.getItem(FX_KEY));
export const saveFx = (fx, st = globalThis.localStorage) => { try { st?.setItem(FX_KEY, JSON.stringify(fx)); } catch {} };

const RN_DIR = '/vendor/rnnoise/';
const RN_PROC = '@sapphi-red/web-noise-suppressor/rnnoise';
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
let rnBinary = null; // binaire wasm, téléchargé une fois par page (≈ 150 ko, servi par ton serveur)
const rnModules = new WeakMap(); // contexte → module du worklet RNNoise chargé
const deModules = new WeakMap(); // contexte → module du dé-esseur chargé
const atModules = new WeakMap(); // contexte → module de l'autotune chargé
const isoModules = new WeakMap(); // contexte → module de l'isolateur chargé
export const autotuneSupported = () => typeof AudioWorkletNode === 'function';

// Isolateur de voix : module WebAssembly de DeepFilterNet3 (34 Mo, servi en brotli ≈ 10,7 Mo), téléchargé une fois
// par page et seulement quand l'interrupteur est activé ; la progression alimente l'indicateur de chargement.
const DF_DIR = '/vendor/deepfilter/';
export const isoLoad = { state: 'idle', loaded: 0, total: 0, error: '' }; // idle | download | compile | ready | error
let dfModule = null, dfBytes = null; // octets gardés seulement jusqu'à ce que le module compilé ait pu être transmis
export const isolatorSupported = () => typeof WebAssembly === 'object' && typeof WebAssembly.compile === 'function' && typeof AudioWorkletNode === 'function';
function loadDf() {
  dfModule ||= (async () => {
    if (!isolatorSupported()) throw new Error('AudioWorklet ou WebAssembly indisponible');
    let simd = false; try { simd = WebAssembly.validate(SIMD_PROBE); } catch {}
    if (!simd) throw new Error('WebAssembly SIMD indisponible (navigateur trop ancien)');
    isoLoad.state = 'download';
    const info = await (await fetch(DF_DIR + 'info.json')).json();
    isoLoad.total = info.size; isoLoad.loaded = 0;
    const r = await fetch(DF_DIR + 'df_bg.wasm');
    if (!r.ok) throw new Error('modèle ' + r.status);
    let bytes;
    if (r.body?.getReader) {
      bytes = new Uint8Array(info.size); const rd = r.body.getReader(); let at = 0;
      for (;;) { const { done, value } = await rd.read(); if (done) break; if (at + value.length > bytes.length) { const b = new Uint8Array(Math.max(bytes.length * 2, at + value.length)); b.set(bytes); bytes = b; } bytes.set(value, at); at += value.length; isoLoad.loaded = at; }
      bytes = bytes.subarray(0, at);
    } else { bytes = new Uint8Array(await r.arrayBuffer()); isoLoad.loaded = bytes.length; }
    isoLoad.state = 'compile';
    const module = await WebAssembly.compile(bytes);
    isoLoad.state = 'ready'; dfBytes = bytes;
    return module;
  })().catch(e => { dfModule = null; isoLoad.state = 'error'; isoLoad.error = String(e?.message || e); throw e; });
  return dfModule;
}
async function isolatorNode(ctx, level) {
  const module = await loadDf();
  if (!isoModules.has(ctx)) isoModules.set(ctx, ctx.audioWorklet.addModule('/js/isolateur-worklet.js').catch(e => { isoModules.delete(ctx); throw e; }));
  await isoModules.get(ctx);
  const opts = { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit' };
  let node;
  // module compilé transmis au worklet ; sinon (clonage refusé) les octets, compilés sur place
  try { node = new AudioWorkletNode(ctx, 'cc-isolateur', { ...opts, processorOptions: { module, isoLevel: level } }); dfBytes = null; }
  catch (e) {
    if (!dfBytes) throw e;
    node = new AudioWorkletNode(ctx, 'cc-isolateur', { ...opts, processorOptions: { bytes: dfBytes.slice().buffer, isoLevel: level } });
  }
  // démarrage du modèle (≈ 0,3 à 0,5 s, sur le fil audio) : on attend sa réponse avant de le brancher
  const ready = await new Promise(resolve => {
    const t = setTimeout(() => resolve({ type: 'error', message: 'le modèle ne répond pas' }), 20000);
    node.port.onmessage = e => { if (e.data?.type === 'ready' || e.data?.type === 'error') { clearTimeout(t); resolve(e.data); } };
    node.onprocessorerror = () => { clearTimeout(t); resolve({ type: 'error', message: 'erreur du worklet' }); };
  });
  if (ready.type !== 'ready') { try { node.disconnect(); } catch {} throw new Error(ready.message); }
  node.startMs = ready.ms;
  return node;
}

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
    this.status = { ns: 'off', iso: 'off', tune: 'off', comp: 'off', deess: 'off' };
    this.iso = null; this.isoError = null; this.isoLoading = null; this.isoInfo = null; this.isoStartMs = null;
    this.isoLatencyMs = isoLatency(ctx.sampleRate) / ctx.sampleRate * 1000;
    this.onNativeIso = null; // repli : media.js demande l'isolation de voix du système si le micro la propose
    this.tune = null; this.tuneError = null; this.tuneInfo = null;
    this.tuneLatencyMs = tuneLatency(ctx.sampleRate) / ctx.sampleRate * 1000;
    this.deessDb = 0; this.nsInfo = '';
    this.comp = ctx.createDynamicsCompressor();
    for (const [k, v] of Object.entries(COMPRESSOR)) this.comp[k].value = v;
    this.makeup = ctx.createGain(); this.makeup.gain.value = Math.pow(10, COMPRESSOR_MAKEUP_DB / 20);
    this.comp.connect(this.makeup);
    this.de = null; this.deError = null; this.ns = null; this.nsLoading = null; this.seq = 0;
    this.wire();
  }
  // Applique les cinq interrupteurs. Renvoie l'état effectif ({ ns, iso, tune, comp, deess } : 'on' | 'off' | 'chargement'
  // | 'indisponible', et 'inclus' pour la réduction de bruit quand l'isolateur la remplace).
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
    if (this.fx.tune && !this.tune && !this.tuneError) {
      try {
        if (!autotuneSupported()) throw new Error('AudioWorklet indisponible');
        if (!atModules.has(this.ctx)) atModules.set(this.ctx, this.ctx.audioWorklet.addModule('/js/autotune-worklet.js').catch(e => { atModules.delete(this.ctx); throw e; }));
        await atModules.get(this.ctx);
        if (!this.tune) {
          this.tune = new AudioWorkletNode(this.ctx, 'cc-autotune', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
            processorOptions: this.tuneParams() });
          this.tune.port.onmessage = e => { this.tuneInfo = e.data; };
        }
      } catch (e) { this.tuneError = String(e?.message || e); }
      if (my === this.seq) this.wire();
    }
    this.tune?.port.postMessage(this.tuneParams()); // vitesse, tonalité, mode : à chaud
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
    this.iso?.port.postMessage({ isoLevel: this.fx.isoLevel }); // intensité : à chaud
    if (this.fx.iso && !this.iso && !this.isoError) {
      try {
        this.isoLoading ||= isolatorNode(this.ctx, this.fx.isoLevel);
        this.wire();
        const node = await this.isoLoading;
        if (!this.iso) {
          this.iso = node; this.isoStartMs = node.startMs;
          node.port.onmessage = e => {
            const d = e.data;
            if (d?.type === 'info') this.isoInfo = d;
            else if (d?.type === 'surcharge') { this.isoError = `appareil trop lent (calcul ${Math.round(d.load * 100)} % du temps réel)`; this.wire(); this.onNativeIso?.(true); this.onChange?.(); }
          };
          node.port.postMessage({ isoLevel: this.fx.isoLevel });
        }
      } catch (e) { this.isoError = String(e?.message || e); }
      this.isoLoading = null;
      if (my === this.seq) this.wire();
    }
    if (this.isoError) this.onNativeIso?.(!!this.fx.iso);
    return this.status;
  }
  tuneParams() { return { tuneSpeed: this.fx.tuneSpeed, tuneKey: this.fx.tuneKey, tuneMinor: this.fx.tuneMinor }; }
  wire() {
    const all = [this.input, this.ns, this.iso, this.tune, this.comp, this.makeup, this.de].filter(Boolean);
    for (const n of all) { if (n === this.comp) continue; try { n.disconnect(); } catch {} }
    const stages = [], isoOn = this.fx.iso && this.iso && !this.isoError;
    if (isoOn) stages.push([this.iso, this.iso]);
    else if (this.fx.ns && this.ns) stages.push([this.ns, this.ns]);
    if (this.fx.tune && this.tune) stages.push([this.tune, this.tune]);
    if (this.fx.comp) stages.push([this.comp, this.makeup]);
    if (this.fx.deess && this.de) stages.push([this.de, this.de]);
    let last = this.input;
    for (const [a, b] of stages) { last.connect(a); last = b; }
    last.connect(this.output);
    this.status.ns = this.nsError ? 'indisponible' : !this.fx.ns ? 'off' : isoOn ? 'inclus' : this.ns ? 'on' : 'chargement';
    this.status.iso = this.isoError ? 'indisponible' : !this.fx.iso ? 'off' : this.iso ? 'on' : 'chargement';
    if (!this.fx.iso) this.isoInfo = null;
    this.status.tune = this.tuneError ? 'indisponible' : !this.fx.tune ? 'off' : this.tune ? 'on' : 'chargement';
    if (!this.fx.tune) this.tuneInfo = null;
    this.status.comp = this.fx.comp ? 'on' : 'off';
    this.status.deess = this.deError ? 'indisponible' : !this.fx.deess ? 'off' : this.de ? 'on' : 'chargement';
  }
  // Réduction de gain en cours (dB, valeurs positives) : affichage « en direct » sous les interrupteurs.
  meters() { return { comp: this.fx.comp ? Math.max(0, -(this.comp.reduction?.value ?? this.comp.reduction ?? 0)) : 0, deess: this.fx.deess ? this.deessDb : 0, tune: this.fx.tune ? this.tuneInfo : null, iso: this.fx.iso ? this.isoInfo : null }; }
  dispose() {
    for (const n of [this.input, this.ns, this.iso, this.tune, this.comp, this.makeup, this.de, this.output]) { try { n?.disconnect(); } catch {} }
    try { this.ns?.port.postMessage('destroy'); } catch {}
  }
}
