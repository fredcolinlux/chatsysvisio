import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, waitMedia, withQuery } from './helpers.mjs';

// Banc de mesure vidéo (pas un test de non-régression) : MESURE=1 npx playwright test mesure-video
// Fausse caméra 1920×1080 : mire fixe détaillée (traits fins, texte, dégradés) + bruit de capteur (σ réglable)
// + un bloc mobile en bas. À l'arrivée : résolution, i/s, débit, PSNR luma de la zone fixe face à la mire propre.
test.skip(!process.env.MESURE, 'banc de mesure : MESURE=1');

function camInit({ sigma }) {
  const W = 1920, H = 1080;
  const chart = () => {
    const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d', { alpha: false });
    const gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, '#2b3445'); gr.addColorStop(1, '#c9b49a'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 60; i++) { g.fillStyle = i % 2 ? '#111' : '#eee'; g.fillRect(80 + i * 6, 80, 3, 300); }
    for (let i = 0; i < 40; i++) { g.strokeStyle = `hsl(${i * 9},60%,50%)`; g.lineWidth = 1 + (i % 3); g.beginPath(); g.moveTo(520, 80 + i * 8); g.lineTo(1100, 120 + i * 9); g.stroke(); }
    g.fillStyle = '#f4f1ea'; g.font = '22px sans-serif';
    for (let r = 0; r < 12; r++) g.fillText('ChatSysVisio netteté 1080p — Logitech 0123456789 abcdefghijklmnopqrstuvwxyz', 1150, 100 + r * 28);
    g.font = '13px sans-serif'; for (let r = 0; r < 20; r++) g.fillText('petit texte de détail fin pour juger la netteté réelle du flux reçu', 80, 420 + r * 17);
    for (let i = 0; i < 8; i++) { const rg = g.createRadialGradient(900 + i * 120, 600, 5, 900 + i * 120, 600, 60); rg.addColorStop(0, '#e0ac8a'); rg.addColorStop(1, '#3a2a22'); g.fillStyle = rg; g.beginPath(); g.arc(900 + i * 120, 600, 58, 0, 7); g.fill(); }
    return c;
  };
  window.__chart = chart;
  const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
  md.getUserMedia = async c => {
    const out = new MediaStream();
    if (c?.audio) { try { (await orig({ audio: c.audio })).getAudioTracks().forEach(t => out.addTrack(t)); } catch {} }
    if (c?.video) {
      const base = chart(), cv = document.createElement('canvas'); cv.width = W; cv.height = H; const g = cv.getContext('2d', { alpha: false });
      // 4 trames de bruit pré-calculées (gris centré, mélange « overlay » ≈ bruit additif)
      const nz = [0, 1, 2, 3].map(() => { const n = document.createElement('canvas'); n.width = W; n.height = H; const ng = n.getContext('2d'); const id = ng.createImageData(W, H);
        for (let i = 0; i < id.data.length; i += 4) { const u = (Math.random() + Math.random() + Math.random() - 1.5) * 2 * sigma; id.data[i] = id.data[i + 1] = id.data[i + 2] = 128 + u; id.data[i + 3] = 255; } ng.putImageData(id, 0, 0); return n; });
      let k = 0;
      const draw = () => { g.globalCompositeOperation = 'copy'; g.drawImage(base, 0, 0); g.globalCompositeOperation = 'source-over';
        if (sigma) { g.globalCompositeOperation = 'overlay'; g.drawImage(nz[k % 4], 0, 0); g.globalCompositeOperation = 'source-over'; }
        k++; g.fillStyle = '#3d7bd9'; g.fillRect((k * 23) % (W - 300), H - 180, 300, 150); requestAnimationFrame(draw); };
      draw();
      out.addTrack(cv.captureStream(30).getVideoTracks()[0]);
    }
    return out;
  };
}

const best = (fr, layer) => Object.entries(fr).filter(([k]) => k.endsWith(':' + layer)).map(([, v]) => v).sort((a, b) => b.h - a.h)[0];

for (const sigma of [0, 10]) test(`mesure 1080p, bruit σ=${sigma}`, async ({ browser }) => {
  test.setTimeout(120_000);
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  await a.addInitScript(camInit, { sigma }); await b.addInitScript(camInit, { sigma: 0 });
  await a.goto('/'); await a.evaluate(() => localStorage.setItem('cc-quality', '1080p'));
  const url = await createRoom(a, 'Mesure ' + sigma);
  await a.goto(withQuery(url, '?force=nolag'));
  await joinRoom(a, a.url(), 'Alice'); await joinRoom(b, url, 'Bruno');
  await waitMedia(b, { video: 20, audio: 0 });
  await expect.poll(async () => best(await b.evaluate(() => window.__cc.frames || {}), 3)?.h || 0, { timeout: 40_000 }).toBe(1080);
  await b.waitForTimeout(3000);
  const s0 = await a.evaluate(() => ({ bytes: window.__cc.sent.bytes, t: performance.now() }));
  const f0 = await b.evaluate(() => Object.entries(window.__cc.frames).find(([k]) => k.endsWith(':3'))[1].n);
  const psnr = [];
  for (let i = 0; i < 16; i++) {
    await b.waitForTimeout(500);
    psnr.push(await b.evaluate(() => {
      const t = [...window.__ccState.tiles.values()].find(x => !x.isMe && x.kind === 'cam'); const c = t.canvas;
      if (c.width !== 1920) return null;
      const got = c.getContext('2d').getImageData(0, 0, 1920, 860).data;
      const ref = window.__chart().getContext('2d').getImageData(0, 0, 1920, 860).data;
      let se = 0, n = 0; for (let j = 0; j < got.length; j += 4) { const y1 = .299 * got[j] + .587 * got[j + 1] + .114 * got[j + 2], y2 = .299 * ref[j] + .587 * ref[j + 1] + .114 * ref[j + 2]; se += (y1 - y2) ** 2; n++; }
      // détail conservé : corrélation des hautes fréquences (laplacien) reçu / mire propre ; le bruit, non corrélé, n'y compte pas
      const W = 1920, L = (d, i) => .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2];
      const lap = (d, x, y) => { const i = (y * W + x) * 4; return 4 * L(d, i) - L(d, i - 4) - L(d, i + 4) - L(d, i - W * 4) - L(d, i + W * 4); };
      let ab = 0, aa = 0, bb = 0; for (let y = 60; y < 840; y++) for (let x = 60; x < 1900; x++) { const a = lap(got, x, y), b = lap(ref, x, y); ab += a * b; aa += a * a; bb += b * b; }
      return [10 * Math.log10(255 * 255 / (se / n)), ab / Math.sqrt(aa * bb)];
    }));
  }
  const s1 = await a.evaluate(() => ({ bytes: window.__cc.sent.bytes, t: performance.now(), send: window.__cc.send, lag: window.__cc.send_lag, err: window.__cc.errors.slice(-3) }));
  const f1 = await b.evaluate(() => Object.entries(window.__cc.frames).find(([k]) => k.endsWith(':3'))[1]);
  const sec = (s1.t - s0.t) / 1000, all = psnr.filter(x => x), p = all.map(x => x[0]), det = all.map(x => x[1]);
  const res = { sigma, res: `${f1.w}x${f1.h}`, fps: +((f1.n - f0) / sec).toFixed(1), mbps: +((s1.bytes - s0.bytes) * 8 / sec / 1e6).toFixed(2),
    psnrMoy: +(p.reduce((x, y) => x + y, 0) / p.length).toFixed(2), psnrMin: +Math.min(...p).toFixed(2), detail: +(det.reduce((x, y) => x + y, 0) / det.length).toFixed(3), detailMin: +Math.min(...det).toFixed(3), sendH: s1.send?.sendH, adapt: s1.send?.adapt, lag: s1.lag, err: s1.err };
  console.log('MESURE ' + JSON.stringify(res));
  await ca.close(); await cb.close();
});
