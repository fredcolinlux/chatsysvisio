// Banc vidéo hors temps réel (1.10) : encode/décode en WebCodecs VP8, dans Chrome, une mire 1080p détaillée avec
// bruit de capteur et bloc mobile, puis mesure la qualité reçue sans dépendre de la charge CPU de la machine.
//   node scripts/video-bench.mjs [url d'une page localhost quelconque]
// Mesures : PSNR luma face à la source bruitée (fidélité), face à la mire propre, détail conservé (corrélation des
// hautes fréquences avec la mire propre), pire image (respiration aux images clés), débit réel.
import { chromium } from '@playwright/test';
const url = process.argv[2] || 'http://localhost:8799/';
const b = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome' });
const p = await b.newPage(); await p.goto(url);
const run = cfg => p.evaluate(async ({ kbps, keyMs, sigma, sec, fps }) => {
  const W = 1920, H = 1080, N = Math.round(sec * fps);
  const chart = document.createElement('canvas'); chart.width = W; chart.height = H; const g = chart.getContext('2d', { alpha: false });
  const gr = g.createLinearGradient(0, 0, W, 0); gr.addColorStop(0, '#2b3445'); gr.addColorStop(1, '#c9b49a'); g.fillStyle = gr; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 60; i++) { g.fillStyle = i % 2 ? '#111' : '#eee'; g.fillRect(80 + i * 6, 80, 3, 300); }
  for (let i = 0; i < 40; i++) { g.strokeStyle = `hsl(${i * 9},60%,50%)`; g.lineWidth = 1 + (i % 3); g.beginPath(); g.moveTo(520, 80 + i * 8); g.lineTo(1100, 120 + i * 9); g.stroke(); }
  g.fillStyle = '#f4f1ea'; g.font = '22px sans-serif'; for (let r = 0; r < 12; r++) g.fillText('ChatSysVisio netteté 1080p — Logitech 0123456789 abcdefghijklmnopqrstuvwxyz', 1150, 100 + r * 28);
  g.font = '13px sans-serif'; for (let r = 0; r < 20; r++) g.fillText('petit texte de détail fin pour juger la netteté réelle du flux reçu', 80, 420 + r * 17);
  for (let i = 0; i < 8; i++) { const rg = g.createRadialGradient(900 + i * 120, 600, 5, 900 + i * 120, 600, 60); rg.addColorStop(0, '#e0ac8a'); rg.addColorStop(1, '#3a2a22'); g.fillStyle = rg; g.beginPath(); g.arc(900 + i * 120, 600, 58, 0, 7); g.fill(); }
  const clean = g.getImageData(0, 0, W, H).data;
  // graine fixe : mêmes trames de bruit d'un essai à l'autre
  let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const noisy = [0, 1, 2, 3, 4, 5].map(() => { const d = new Uint8ClampedArray(clean); if (sigma) for (let i = 0; i < d.length; i += 4) { const u = (rnd() + rnd() + rnd() - 1.5) * 2 * sigma; d[i] += u; d[i + 1] += u; d[i + 2] += u; } return d; });
  const cv = new OffscreenCanvas(W, H), cg = cv.getContext('2d', { alpha: false, willReadFrequently: true });
  const src = k => { cg.putImageData(new ImageData(noisy[k % 6], W, H), 0, 0); cg.fillStyle = '#3d7bd9'; cg.fillRect((k * 23) % (W - 300), H - 180, 300, 150); return cg.getImageData(0, 0, W, H).data; };
  const Y = (d, i) => .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2];
  const chunks = []; let bytes = 0;
  const enc = new VideoEncoder({ output: c => { const u = new Uint8Array(c.byteLength); c.copyTo(u); bytes += u.length; chunks.push({ type: c.type, ts: c.timestamp, u }); }, error: e => { throw e; } });
  enc.configure({ codec: 'vp8', width: W, height: H, bitrate: kbps * 1000, framerate: fps, latencyMode: 'realtime' });
  let lastKey = -1e9; const srcs = new Map();
  for (let k = 0; k < N; k++) {
    const ms = k * 1000 / fps, d = src(k);
    if (k % 6 === 0 || k > N - 30) srcs.set(Math.round(ms * 1000), d); // quelques sources gardées pour la fidélité
    const f = new VideoFrame(cv, { timestamp: Math.round(ms * 1000) }); const key = ms - lastKey > keyMs; if (key) lastKey = ms;
    enc.encode(f, { keyFrame: key }); f.close();
    while (enc.encodeQueueSize > 2) await new Promise(r => setTimeout(r, 1));
  }
  await enc.flush(); enc.close();
  const res = []; const out = new OffscreenCanvas(W, H), og = out.getContext('2d', { willReadFrequently: true });
  let pend = Promise.resolve();
  const dec = new VideoDecoder({ output: f => { const ts = f.timestamp; og.drawImage(f, 0, 0); f.close(); const got = og.getImageData(0, 0, W, 860).data;
    let se1 = 0, se2 = 0, n = 0; const s = srcs.get(ts);
    for (let i = 0; i < got.length; i += 16) { const y = Y(got, i); se1 += (y - Y(clean, i)) ** 2; if (s) se2 += (y - Y(s, i)) ** 2; n++; }
    const L = (d, i) => Y(d, i), lap = (d, x, y) => { const i = (y * W + x) * 4; return 4 * L(d, i) - L(d, i - 4) - L(d, i + 4) - L(d, i - W * 4) - L(d, i + W * 4); };
    let ab = 0, aa = 0, bb = 0; for (let y = 60; y < 840; y += 2) for (let x = 60; x < 1900; x += 2) { const a = lap(got, x, y), c = lap(clean, x, y); ab += a * c; aa += a * a; bb += c * c; }
    res.push({ ts, clean: 10 * Math.log10(65025 / (se1 / n)), fid: s ? 10 * Math.log10(65025 / (se2 / n)) : null, det: ab / Math.sqrt(aa * bb) }); }, error: e => { throw e; } });
  dec.configure({ codec: 'vp8' });
  for (const c of chunks) { dec.decode(new EncodedVideoChunk({ type: c.type, timestamp: c.ts, data: c.u })); if (dec.decodeQueueSize > 4) await new Promise(r => setTimeout(r, 2)); }
  await dec.flush();
  const st = res.slice(fps); // après la 1re seconde (montée du débit)
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length, fid = st.filter(r => r.fid != null).map(r => r.fid);
  return { kbps, keyMs, sigma, frames: res.length, mbps: +(bytes * 8 / sec / 1e6).toFixed(2), keys: chunks.filter(c => c.type === 'key').length,
    fidelite: +avg(fid).toFixed(2), fideliteMin: +Math.min(...fid).toFixed(2), psnrPropre: +avg(st.map(r => r.clean)).toFixed(2), detail: +avg(st.map(r => r.det)).toFixed(3), detailMin: +Math.min(...st.map(r => r.det)).toFixed(3) };
}, cfg);
const out = [];
for (const sigma of [0, 6, 12]) for (const [kbps, keyMs, label] of [[2500, 4000, 'avant (2,5 Mbit/s, clé 4 s)'], [4000, 10000, 'après (4 Mbit/s, clé 10 s)'], [2500, 10000, 'clé 10 s seule'], [4000, 4000, '4 Mbit/s seul']]) {
  const r = await run({ kbps, keyMs, sigma, sec: 9, fps: 24 }); r.label = label; out.push(r); console.log(JSON.stringify(r));
}
await b.close();
