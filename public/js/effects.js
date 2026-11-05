// Effets d'arrière-plan : flou et image personnalisée, par segmentation de personne
// (MediaPipe Selfie Segmenter, modèle et moteur WebAssembly servis par ton serveur, rien d'externe).
// Le détourage tourne toujours sur une image réduite (≤ 480 px : le modèle travaille de toute façon en 256×256) ;
// seule la composition (fond + personne) se fait à la taille envoyée, jusqu'en 1080p.
// Repli : si l'appareil est trop lent, la composition descend d'abord en 720p, puis on segmente une image sur deux,
// puis on désactive l'effet.

export const PRESETS = [
  { id: 'salon', label: 'Salon' }, { id: 'nuit', label: 'Nuit' }, { id: 'aurore', label: 'Aurore' }, { id: 'bureau', label: 'Bureau' },
];

export function drawPreset(id, w = 640, h = 360) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d');
  const lin = (stops, x1 = 0, y1 = 0, x2 = w, y2 = h) => { const gr = g.createLinearGradient(x1, y1, x2, y2); stops.forEach(([o, col]) => gr.addColorStop(o, col)); return gr; };
  const blob = (x, y, r, col) => { const gr = g.createRadialGradient(x, y, 0, x, y, r); gr.addColorStop(0, col); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, w, h); };
  if (id === 'salon') {
    g.fillStyle = lin([[0, '#3b2a22'], [1, '#6b4a35']]); g.fillRect(0, 0, w, h);
    g.fillStyle = '#2a1d17'; g.fillRect(0, h * .72, w, h * .28);
    g.fillStyle = 'rgba(255,220,170,.18)'; g.fillRect(w * .62, h * .12, w * .26, h * .42);
    blob(w * .2, h * .3, h * .5, 'rgba(255,190,120,.35)'); blob(w * .8, h * .25, h * .3, 'rgba(255,240,200,.25)');
    g.fillStyle = '#1f6f4a'; g.beginPath(); g.ellipse(w * .12, h * .62, w * .05, h * .16, 0, 0, Math.PI * 2); g.fill();
  } else if (id === 'nuit') {
    g.fillStyle = lin([[0, '#070b1f'], [1, '#1a2350']], 0, 0, 0, h); g.fillRect(0, 0, w, h);
    let x = 7; for (let i = 0; i < 90; i++) { x = (x * 9301 + 49297) % 233280; const px = x / 233280 * w; x = (x * 9301 + 49297) % 233280; const py = x / 233280 * h * .7; g.fillStyle = `rgba(255,255,255,${.3 + (i % 5) / 8})`; g.fillRect(px, py, 1.6, 1.6); }
    blob(w * .78, h * .2, h * .18, 'rgba(255,250,220,.6)'); g.fillStyle = '#0b1029'; g.fillRect(0, h * .8, w, h * .2);
  } else if (id === 'aurore') {
    g.fillStyle = lin([[0, '#1d1145'], [.5, '#3d2a8c'], [1, '#0f3d4a']]); g.fillRect(0, 0, w, h);
    blob(w * .25, h * .3, h * .6, 'rgba(167,139,250,.55)'); blob(w * .75, h * .7, h * .6, 'rgba(45,212,191,.45)'); blob(w * .6, h * .2, h * .4, 'rgba(240,171,252,.35)');
  } else {
    g.fillStyle = lin([[0, '#d9dde6'], [1, '#aeb6c6']]); g.fillRect(0, 0, w, h);
    for (let i = 0; i < 14; i++) blob(w * ((i * 37 % 100) / 100), h * ((i * 53 % 100) / 100), h * (.08 + (i % 4) * .04), `rgba(255,255,255,${.25 + (i % 3) * .1})`);
    g.fillStyle = 'rgba(80,90,110,.25)'; g.fillRect(0, h * .78, w, h * .22);
  }
  return c;
}

export class Effects {
  constructor({ onFallback } = {}) {
    this.mode = 'none'; this.bg = null; this.seg = null; this.loading = null; this.onFallback = onFallback;
    this.out = document.createElement('canvas'); this.octx = this.out.getContext('2d');
    this.person = document.createElement('canvas'); this.pctx = this.person.getContext('2d');
    this.mask = document.createElement('canvas'); this.mctx = this.mask.getContext('2d');
    this.small = document.createElement('canvas'); this.sctx = this.small.getContext('2d');
    this.segIn = document.createElement('canvas'); this.segCtx = this.segIn.getContext('2d', { alpha: false });
    this.composeCap = 1920; // côté long max de la composition (abaissé à 1280 si l'appareil peine)
    this.times = []; this.skip = 1; this.n = 0; this.lastTs = 0; this.maskData = null; this.status = 'off';
  }
  get active() { return this.mode !== 'none' && this.status === 'ready'; }
  async load() {
    if (this.seg) return this.seg;
    if (this.loading) return this.loading;
    this.status = 'loading';
    this.loading = (async () => {
      const { FilesetResolver, ImageSegmenter } = await import('/vendor/mediapipe/vision_bundle.mjs');
      const fs = await FilesetResolver.forVisionTasks('/vendor/mediapipe/wasm');
      const opts = d => ({ baseOptions: { modelAssetPath: '/vendor/mediapipe/selfie_segmenter.tflite', delegate: d }, runningMode: 'VIDEO', outputCategoryMask: false, outputConfidenceMasks: true });
      try { this.seg = await ImageSegmenter.createFromOptions(fs, opts('GPU')); }
      catch { this.seg = await ImageSegmenter.createFromOptions(fs, opts('CPU')); }
      this.status = 'ready';
      return this.seg;
    })().catch(e => { this.status = 'failed'; this.loading = null; throw e; });
    return this.loading;
  }
  async set(mode, bgSource) {
    this.mode = mode; this.times = []; this.skip = 1; this.composeCap = 1920;
    if (bgSource) this.bg = bgSource;
    if (mode === 'none') return;
    await this.load();
  }
  // Renvoie un canvas composé (ou null si inactif). src : <video> caméra.
  // maxSide : côté long voulu (640 pour 360p, 1280 pour 720p, 1920 pour 1080p).
  render(src, maxSide = 640) {
    if (!this.active || !src.videoWidth) return null;
    const vw = src.videoWidth, vh = src.videoHeight, s = Math.min(1, Math.min(maxSide, this.composeCap) / Math.max(vw, vh));
    const w = Math.round(vw * s / 2) * 2, h = Math.round(vh * s / 2) * 2;
    if (this.out.width !== w || this.out.height !== h) { this.out.width = this.person.width = w; this.out.height = this.person.height = h; }
    const t0 = performance.now();
    if (this.n++ % this.skip === 0 || !this.maskData) {
      let ts = Math.max(t0, this.lastTs + 1); this.lastTs = ts;
      try {
        const k = Math.min(1, 480 / Math.max(vw, vh)), iw = Math.round(vw * k), ih = Math.round(vh * k);
        if (this.segIn.width !== iw || this.segIn.height !== ih) { this.segIn.width = iw; this.segIn.height = ih; }
        this.segCtx.drawImage(src, 0, 0, iw, ih);
        this.seg.segmentForVideo(this.segIn, ts, r => {
          const m = r.confidenceMasks?.[0]; if (!m) return;
          const mw = m.width, mh = m.height, f = m.getAsFloat32Array();
          if (this.mask.width !== mw || this.mask.height !== mh) { this.mask.width = mw; this.mask.height = mh; this.maskData = null; }
          const id = this.maskData || (this.maskData = this.mctx.createImageData(mw, mh)), d = id.data;
          for (let i = 0, j = 0; i < f.length; i++, j += 4) {
            const a = f[i]; d[j] = d[j + 1] = d[j + 2] = 255; d[j + 3] = a < .25 ? 0 : a > .75 ? 255 : (a - .25) * 510;
          }
          this.mctx.putImageData(id, 0, 0);
          r.close?.();
        });
      } catch (e) { this.fail('segmentation'); return null; }
    }
    const o = this.octx;
    // Fond
    if (this.mode === 'blur') {
      const sw = Math.max(16, w >> 4), sh = Math.max(9, h >> 4);
      this.small.width = sw; this.small.height = sh;
      this.sctx.drawImage(src, 0, 0, sw, sh);
      o.imageSmoothingEnabled = true; o.imageSmoothingQuality = 'high';
      o.drawImage(this.small, 0, 0, w, h);
    } else if (this.bg) {
      const bw = this.bg.width, bh = this.bg.height, k = Math.max(w / bw, h / bh);
      o.drawImage(this.bg, (w - bw * k) / 2, (h - bh * k) / 2, bw * k, bh * k);
    }
    // Personne détourée
    const p = this.pctx;
    p.globalCompositeOperation = 'copy'; p.drawImage(src, 0, 0, w, h);
    p.globalCompositeOperation = 'destination-in'; p.imageSmoothingEnabled = true; p.drawImage(this.mask, 0, 0, w, h);
    p.globalCompositeOperation = 'source-over';
    o.drawImage(this.person, 0, 0);
    // Garde-fou de performance
    const dt = performance.now() - t0; this.times.push(dt); if (this.times.length > 30) this.times.shift();
    if (this.times.length === 30) {
      const avg = this.times.reduce((a, b) => a + b) / 30;
      if (avg > 90 && this.skip >= 2) this.fail('lent');
      else if (avg > 45 && Math.max(w, h) > 1280) { this.composeCap = 1280; this.times = []; } // 1080p → 720p d'abord
      else if (avg > 45 && this.skip === 1) { this.skip = 2; this.times = []; }
    }
    return this.out;
  }
  fail(why) {
    this.mode = 'none';
    this.onFallback?.(why === 'lent' ? 'Effet d\'arrière-plan désactivé : appareil trop lent.' : 'Effet d\'arrière-plan indisponible sur cet appareil.');
  }
}
