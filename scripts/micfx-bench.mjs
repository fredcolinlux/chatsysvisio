#!/usr/bin/env node
// Coût CPU du traitement du micro : rendu hors ligne de 60 s de son à travers la chaîne, dans Chrome.
// charge = temps de calcul / durée du son (part d'un cœur). Usage : node scripts/micfx-bench.mjs [http://127.0.0.1:8790]
// (Le bridage CPU de Chrome DevTools n'agit pas sur le fil audio : la mesure sur téléphone se fait sur l'appareil.)
import { chromium } from '@playwright/test';
const base = (process.argv.slice(2).find(a => !a.startsWith('--')) || 'http://127.0.0.1:8790').replace(/\/+$/, '');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
const page = await browser.newPage();
await page.goto(base + '/r/banc-micro');
const res = await page.evaluate(async () => {
  const { MicChain } = await import('/js/micfx.js');
  const sr = 48000, sec = 60, out = {};
  for (const [label, fx] of [['aucun', {}], ['compresseur', { comp: true }], ['dé-esseur', { deess: true }], ['réduction de bruit', { ns: true }], ['les trois', { ns: true, comp: true, deess: true }]]) {
    const ctx = new OfflineAudioContext(1, sr * sec, sr);
    await ctx.audioWorklet.addModule('/js/worklets.js');
    const c = new MicChain(ctx); await c.set({ ns: false, comp: false, deess: false, ...fx });
    const b = ctx.createBuffer(1, sr, sr), x = b.getChannelData(0); for (let i = 0; i < sr; i++) x[i] = (Math.random() * 2 - 1) * 0.05 + 0.2 * Math.sin(i / 20);
    const s = ctx.createBufferSource(); s.buffer = b; s.loop = true; s.connect(c.input); c.output.connect(ctx.destination); s.start();
    ctx.suspend(0.01).then(() => setTimeout(() => ctx.resume(), 500));
    const t0 = performance.now(); await ctx.startRendering(); const ms = performance.now() - t0 - 500;
    out[label] = +(ms / (sec * 1000) * 100).toFixed(2);
  }
  return { charge_pourcent_dun_coeur: out, simd: WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11])), coeurs: navigator.hardwareConcurrency };
});
console.log(JSON.stringify(res, null, 1));
await browser.close();
