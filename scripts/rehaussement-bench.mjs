// Banc du rehaussement faible lumière (1.11), dans Chrome, avec la fausse caméra « pièce sombre »
// (scripts/fausse-camera-sombre.mjs) branchée comme vraie webcam (--use-file-for-fake-video-capture).
//   node scripts/fausse-camera-sombre.mjs /tmp/csv-sombre-1080.y4m
//   node scripts/rehaussement-bench.mjs http://localhost:8799/ /tmp/csv-sombre-1080.y4m [image-avant-apres.png]
// Mesures par configuration : coût par image (GPU compris : lecture synchrone d'un pixel après chaque image),
// cadence traitée, luminance moyenne, bruit temporel d'une zone fixe (carton gris) avant / après, pixels brûlés.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const url = process.argv[2] || 'http://localhost:8799/';
const y4m = process.argv[3] || '/tmp/csv-sombre-1080.y4m';
const png = process.argv[4] || '';
const ZONE = { x: 0.16, y: 0.56, w: 0.07, h: 0.12 };
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${y4m}`, '--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } }); await p.goto(url);
const gpu = await p.evaluate(() => { const g = document.createElement('canvas').getContext('webgl2'); const d = g?.getExtension('WEBGL_debug_renderer_info'); return g ? (d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'WebGL2') : 'aucun WebGL2'; });
await p.evaluate(async () => {
  const s = await navigator.mediaDevices.getUserMedia({ video: { width: 1920, height: 1080, frameRate: 24 } });
  const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.srcObject = s; v.style.cssText = 'position:fixed;left:0;top:0;width:160px;height:90px';
  document.body.append(v); await v.play(); window.__v = v;
  window.__R = await import('/js/rehausse.js');
});
const run = cfg => p.evaluate(async ({ k, side, level, sec, Z, wb }) => {
  const { Rehausse, meanLuma } = window.__R, v = window.__v;
  const e = new Rehausse({ guard: false }); e.set({ on: true, k, wb }); e.level = level;
  const c2 = document.createElement('canvas'), g2 = c2.getContext('2d', { willReadFrequently: true });
  const zone = (src, w, h) => { const zx = Math.round(Z.x * w), zy = Math.round(Z.y * h), zw = Math.round(Z.w * w), zh = Math.round(Z.h * h); c2.width = w; c2.height = h; g2.drawImage(src, 0, 0, w, h); return { z: g2.getImageData(zx, zy, zw, zh).data, all: g2.getImageData(0, 0, w, h).data }; };
  const costs = [], before = [], after = [], lumB = [], lumA = [], burnB = [], burnA = [];
  let n = 0, t0 = 0;
  const burnt = d => { let c = 0; for (let i = 0; i < d.length; i += 16) if (d[i] >= 250 && d[i + 1] >= 250 && d[i + 2] >= 250) c++; return c / (d.length / 16); };
  await new Promise(res => {
    const tick = () => {
      const now = performance.now(); if (!t0) t0 = now;
      const a = performance.now();
      const out = e.render(v, side, { force: true });
      const gl = e.gl; if (gl) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)); // attend la fin du travail GPU
      const dt = performance.now() - a;
      if (n >= 12) costs.push(dt);
      // mesures image (hors chronométrage) : 24 images consécutives après stabilisation du filtre temporel
      if (n >= 24 && n < 48) {
        const w = out.width, h = out.height, rb = zone(v, w, h); before.push(rb.z); lumB.push(meanLuma(rb.all)); burnB.push(burnt(rb.all));
        const ra = zone(out, w, h); after.push(ra.z); lumA.push(meanLuma(ra.all)); burnA.push(burnt(ra.all));
      }
      n++;
      if (now - t0 < sec * 1000 || n < 50) v.requestVideoFrameCallback(tick); else res();
    };
    v.requestVideoFrameCallback(tick);
  });
  const el = performance.now() - t0;
  // bruit temporel : écart-type par pixel (luma) sur 24 images, moyenné sur la zone
  const tstd = fr => { const m = fr[0].length / 4; let s = 0, mu = 0; for (let i = 0; i < m; i++) { let a = 0, a2 = 0; for (const f of fr) { const y = .299 * f[i * 4] + .587 * f[i * 4 + 1] + .114 * f[i * 4 + 2]; a += y; a2 += y * y; } const mm = a / fr.length; mu += mm; s += Math.sqrt(Math.max(0, a2 / fr.length - mm * mm)); } return { std: s / m, mean: mu / m }; };
  const nb = tstd(before), na = tstd(after);
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length; const sorted = [...costs].sort((x, y) => x - y);
  return { k, side: Math.max(e.cv.width, e.cv.height), level, mode: e.mode, f16: e.f16, frames: n, fps: +(n * 1000 / el).toFixed(1), cost: +avg(costs).toFixed(1), p95: +sorted[Math.floor(sorted.length * .95)].toFixed(1),
    lumBefore: +avg(lumB).toFixed(1), lumAfter: +avg(lumA).toFixed(1), noiseBefore: +nb.std.toFixed(2), noiseAfter: +na.std.toFixed(2), zoneBefore: +nb.mean.toFixed(1), zoneAfter: +na.mean.toFixed(1),
    snrBefore: +(nb.mean / nb.std).toFixed(1), snrAfter: +(na.mean / na.std).toFixed(1), burntBefore: +(avg(burnB) * 100).toFixed(2), burntAfter: +(avg(burnA) * 100).toFixed(2) };
}, { ...cfg, Z: ZONE });
const res = [];
for (const cfg of process.env.QUICK ? [] : [{ k: 0.6, side: 1920, level: 0, sec: 6 }, { k: 0.6, side: 1920, level: 1, sec: 6 }, { k: 0.6, side: 1280, level: 0, sec: 6 }, { k: 0.6, side: 640, level: 0, sec: 4 }, { k: 1, side: 1920, level: 0, sec: 5 }, { k: 0.6, side: 1920, level: 0, sec: 5, wb: true }]) {
  const r = await run(cfg); res.push({ ...r, wb: !!cfg.wb }); console.log(JSON.stringify(r));
}
if (png) {
  // côte à côte : la même image caméra, brute à gauche, passée dans le vrai shader à droite
  const data = await p.evaluate(async () => {
    const { Rehausse } = window.__R, v = window.__v, e = new Rehausse({ guard: false }); e.set({ on: true, k: 0.6 });
    let n = 0; const W = 1280, H = 720, top = 64;
    const c = document.createElement('canvas'); c.width = W * 2 + 24; c.height = H + top + 16; const g = c.getContext('2d');
    await new Promise(res => { const tick = () => { const out = e.render(v, 1920, { force: true }); if (++n === 40) { g.fillStyle = '#0b0d11'; g.fillRect(0, 0, c.width, c.height); g.drawImage(v, 0, top, W, H); g.drawImage(out, W + 24, top, W, H); res(); } else v.requestVideoFrameCallback(tick); }; v.requestVideoFrameCallback(tick); });
    g.font = '600 26px Inter, system-ui, sans-serif'; g.fillStyle = '#eceef2'; g.fillText('Avant : caméra brute', 8, 42); g.fillText('Après : rehaussement faible lumière (60 %)', W + 32, 42);
    g.fillStyle = '#7eaaff'; g.fillRect(W + 32, 52, 120, 3);
    return c.toDataURL('image/png');
  });
  fs.writeFileSync(png, Buffer.from(data.split(',')[1], 'base64')); console.log('image :', png);
}
console.log(JSON.stringify({ gpu, res }));
await b.close();
