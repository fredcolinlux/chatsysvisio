// Mire de couleurs (barres SMPTE 75 % + 100 % + teinte peau) injectée à la place de la caméra, et mesure à l'arrivée.
export const BARS = [
  ['blanc 75', [191, 191, 191]], ['jaune', [191, 191, 0]], ['cyan', [0, 191, 191]], ['vert', [0, 191, 0]],
  ['magenta', [191, 0, 191]], ['rouge', [191, 0, 0]], ['bleu', [0, 0, 191]],
];
export const BOTTOM = [['noir', [16, 16, 16]], ['blanc 100', [255, 255, 255]], ['peau', [224, 172, 138]], ['rouge 100', [255, 0, 0]], ['bleu 100', [0, 0, 255]], ['gris 50', [128, 128, 128]]];

// Script exécuté dans la page avant tout : getUserMedia renvoie la mire (+ le micro factice d'origine).
export function mireInit({ bars, bottom, noise = 0, yuv = null, size = [1280, 720] }) {
  const md = navigator.mediaDevices; if (!md) return;
  const orig = md.getUserMedia.bind(md);
  md.getUserMedia = async c => {
    const out = new MediaStream();
    if (c?.audio) { try { (await orig({ audio: c.audio })).getAudioTracks().forEach(t => out.addTrack(t)); } catch {} }
    if (c?.video) {
      if (yuv && window.MediaStreamTrackGenerator) { // vraie caméra : images YUV (I420) avec leur espace colorimétrique
        const [W, H] = size, gen = new MediaStreamTrackGenerator({ kind: 'video' }), wr = gen.writable.getWriter();
        const K = { bt709: [0.2126, 0.0722], smpte170m: [0.299, 0.114], bt470bg: [0.299, 0.114] }[yuv.matrix];
        const buf = new Uint8Array(W * H * 1.5), Y = buf.subarray(0, W * H), U = buf.subarray(W * H, W * H * 1.25), V = buf.subarray(W * H * 1.25);
        const px = (x, y) => { const row = y < H * 2 / 3 ? bars : bottom; return row[Math.min(row.length - 1, Math.floor(x / W * row.length))][1]; };
        const conv = ([r, g, b]) => { const [kr, kb] = K, kg = 1 - kr - kb; r /= 255; g /= 255; b /= 255;
          const y = kr * r + kg * g + kb * b, u = (b - y) / (2 * (1 - kb)), v = (r - y) / (2 * (1 - kr));
          return yuv.fullRange ? [y * 255, 128 + u * 255, 128 + v * 255] : [16 + y * 219, 128 + u * 224, 128 + v * 224]; };
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const c = conv(px(x, y)); Y[y * W + x] = c[0]; if (!(x & 1) && !(y & 1)) { const i = (y >> 1) * (W >> 1) + (x >> 1); U[i] = c[1]; V[i] = c[2]; } }
        const cs = { matrix: yuv.matrix, primaries: yuv.matrix === 'bt709' ? 'bt709' : 'smpte170m', transfer: yuv.matrix === 'bt709' ? 'bt709' : 'smpte170m', fullRange: !!yuv.fullRange };
        let t = 0; setInterval(() => { const f = new VideoFrame(buf, { format: 'I420', codedWidth: W, codedHeight: H, timestamp: (t += 40000), colorSpace: cs }); wr.write(f).catch(() => {}); }, 40);
        out.addTrack(gen); return out;
      }
      const cv = document.createElement('canvas'); cv.width = 1280; cv.height = 720;
      const g = cv.getContext('2d', { alpha: false }); let n = 0;
      // bruit de capteur (optionnel) : grain gris centré, comme une vraie webcam, pour charger l'encodeur
      let nz = null;
      if (noise) { nz = document.createElement('canvas'); nz.width = 1600; nz.height = 900; const ng = nz.getContext('2d'); const id = ng.createImageData(1600, 900);
        for (let i = 0; i < id.data.length; i += 4) { const v = 128 + (Math.random() * 2 - 1) * noise; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; } ng.putImageData(id, 0, 0); }
      const draw = () => {
        const bw = cv.width / bars.length;
        bars.forEach(([, [r, gg, b]], i) => { g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(Math.round(i * bw), 0, Math.ceil(bw), 480); });
        const ow = cv.width / bottom.length;
        bottom.forEach(([, [r, gg, b]], i) => { g.fillStyle = `rgb(${r},${gg},${b})`; g.fillRect(Math.round(i * ow), 480, Math.ceil(ow), 240); });
        // petit carré mobile : l'encodeur reçoit des images qui changent, sans toucher aux zones mesurées
        if (nz) { g.globalCompositeOperation = 'soft-light'; g.drawImage(nz, -Math.random() * 300, -Math.random() * 170); g.globalCompositeOperation = 'source-over'; }
        g.fillStyle = '#808080'; g.fillRect(((n++ * 8) % 1200), 452, 24, 24);
      };
      draw(); setInterval(draw, 40);
      out.addTrack(cv.captureStream(25).getVideoTracks()[0]);
    }
    return out;
  };
}

// Mesure dans la page qui reçoit : moyenne d'une zone centrale de chaque barre, lue dans la tuile distante.
// source 'canvas' = pixels de la tuile ; un PNG (base64) = capture de l'écran (rendu CSS final).
export async function sampleTile(page, png) {
  return page.evaluate(async ({ png }) => {
    const tile = [...document.querySelectorAll('.tile:not(.me)')].find(t => t.querySelector('canvas')?.width > 16);
    if (!tile) return null;
    const c = tile.querySelector('canvas');
    let data, W, H, ox = 0, oy = 0, sx = 1, sy = 1;
    if (png) {
      const img = await createImageBitmap(new Blob([Uint8Array.from(atob(png), ch => ch.charCodeAt(0))], { type: 'image/png' }));
      const k = document.createElement('canvas'); k.width = img.width; k.height = img.height;
      const kg = k.getContext('2d'); kg.drawImage(img, 0, 0); W = img.width; H = img.height;
      data = kg.getImageData(0, 0, W, H).data;
      const r = c.getBoundingClientRect(), dpr = img.width / innerWidth;
      // object-fit: cover — zone visible de l'image dans la boîte
      const s = Math.max(r.width / c.width, r.height / c.height);
      ox = (r.left + (r.width - c.width * s) / 2) * dpr; oy = (r.top + (r.height - c.height * s) / 2) * dpr; sx = sy = s * dpr;
    } else {
      W = c.width; H = c.height; data = c.getContext('2d').getImageData(0, 0, W, H).data;
    }
    const avg = (fx, fy) => { // fx, fy : position relative dans l'image source (0..1)
      const cx = ox + fx * c.width * sx, cy = oy + fy * c.height * sy, rad = Math.max(2, Math.round(c.width * sx * 0.012));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = Math.round(cy - rad); y <= cy + rad; y++) for (let x = Math.round(cx - rad); x <= cx + rad; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue; const i = (y * W + x) * 4; r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
      }
      return n ? [r / n, g / n, b / n].map(v => Math.round(v)) : null;
    };
    return { w: c.width, h: c.height, avg: [7, 6].map((n, row) => Array.from({ length: n }, (_, i) => avg((i + 0.5) / n, row ? 600 / 720 : 0.35))) };
  }, { png });
}

// ΔE (CIE76, Lab D65) — simple et suffisant pour juger un écart de couleur
const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
export function lab([r, g, b]) {
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047, Y = R * 0.2126 + G * 0.7152 + B * 0.0722, Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}
export const deltaE = (a, b) => { const A = lab(a), B = lab(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };
export const chroma = c => { const [, a, b] = lab(c); return Math.hypot(a, b); };
export function report(sample) {
  const ref = [...BARS, ...BOTTOM], got = [...sample.avg[0], ...sample.avg[1]];
  const rows = ref.map(([n, c], i) => ({ n, ref: c, got: got[i], dE: +deltaE(c, got[i]).toFixed(1), chroma: +(chroma(got[i]) / Math.max(1, chroma(c))).toFixed(2) }));
  const sat = rows.filter(r => chroma(r.ref) > 20);
  return { rows, maxDE: Math.max(...rows.map(r => r.dE)), meanDE: +(rows.reduce((a, r) => a + r.dE, 0) / rows.length).toFixed(1), chromaRatio: +(sat.reduce((a, r) => a + r.chroma, 0) / sat.length).toFixed(2) };
}
