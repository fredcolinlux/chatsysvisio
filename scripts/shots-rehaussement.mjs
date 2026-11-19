// Captures du rehaussement faible lumière (1.11) avec la fausse caméra « pièce sombre ».
//   node scripts/fausse-camera-sombre.mjs /tmp/csv-sombre-1080.y4m
//   BASE=http://localhost:8799 node scripts/shots-rehaussement.mjs /tmp/csv-sombre-1080.y4m
// Produit /workspace/rehaussement-panneau.png (bureau) et /workspace/rehaussement-panneau-mobile.png.
import { chromium } from '@playwright/test';
const BASE = process.env.BASE || 'http://localhost:8799', OUT = process.env.OUT || '/workspace';
const y4m = process.argv[2] || '/tmp/csv-sombre-1080.y4m';
const b = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`, '--autoplay-policy=no-user-gesture-required'] });
// Capacités d'une Logitech C920 sous Chrome / Windows (la fausse caméra n'en expose presque pas)
function c920() {
  window.__ccEnhBudget = 1e6; // machine de capture sans carte graphique : pas de repli automatique
  const P = MediaStreamTrack.prototype, gc = P.getCapabilities, gs = P.getSettings;
  const caps = { brightness: { min: 0, max: 255, step: 1 }, contrast: { min: 0, max: 255, step: 1 }, saturation: { min: 0, max: 255, step: 1 }, sharpness: { min: 0, max: 255, step: 1 },
    exposureMode: ['manual', 'continuous'], exposureTime: { min: 3, max: 2047, step: 1 }, whiteBalanceMode: ['manual', 'continuous'], colorTemperature: { min: 2000, max: 6500, step: 10 }, zoom: { min: 100, max: 500, step: 1 } };
  const cur = { brightness: 128, contrast: 128, saturation: 128, sharpness: 128, exposureMode: 'continuous', exposureTime: 333, whiteBalanceMode: 'continuous', colorTemperature: 4000, zoom: 100 };
  P.getCapabilities = function () { const c = gc.call(this); return this.kind === 'video' ? { ...c, ...caps } : c; };
  P.getSettings = function () { const s = gs.call(this); return this.kind === 'video' ? { ...s, ...cur } : s; };
  Object.defineProperty(P, 'label', { get() { return this.kind === 'video' ? 'HD Pro Webcam C920' : 'Micro'; } });
}
for (const [name, opts] of [['rehaussement-panneau', { viewport: { width: 1440, height: 1480 } }], ['rehaussement-panneau-mobile', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]]) {
  const ctx = await b.newContext({ ...opts, locale: 'fr-FR', colorScheme: 'dark' }); const p = await ctx.newPage();
  await p.addInitScript(c920);
  await p.goto(BASE + '/'); await p.evaluate(() => { localStorage.setItem('cc-name', 'Alice'); localStorage.setItem('cc-quality', '1080p'); localStorage.setItem('csv-cam', JSON.stringify({ enh: { on: true, k: 0.6 } })); });
  await p.fill('#roomName', 'Salon du soir'); await p.click('#go'); await p.waitForURL(/\/r\//);
  await p.waitForTimeout(2500);
  await p.click('.camopen'); await p.waitForTimeout(2500);
  await p.mouse.move(5, 5); await p.evaluate(() => { document.activeElement?.blur(); });
  if (opts.isMobile) await p.evaluate(() => { const m = document.querySelector('.modal'); m.scrollTop = m.querySelector('.camenh').offsetTop - 60; });
  await p.waitForTimeout(400);
  await p.screenshot({ path: `${OUT}/${name}.png` }); console.log(`${OUT}/${name}.png`);
  await ctx.close();
}
await b.close();
