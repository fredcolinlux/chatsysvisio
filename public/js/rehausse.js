// Rehaussement faible lumière (1.11) : éclaircissement adaptatif + débruitage spatio-temporel, sur la carte graphique
// (WebGL2), avant l'encodeur et avant le flou d'arrière-plan (qui segmente et compose l'image déjà rehaussée).
// Rien d'externe : quatre petits shaders, aucune bibliothèque, aucune nouvelle source (CSP inchangée).
//
// Chaîne par image (caméra → rehaussement → [flou / fond] → encodeur) :
//   1. débruitage : filtre bilatéral 5×5 (ou 3×3 en mode allégé) sur la luminance et la couleur, chrominance lissée
//      plus largement (le bruit couleur des webcams est grossier), puis mélange temporel récursif avec l'image
//      précédente, coupé là où ça bouge (détection de mouvement par pixel) pour éviter les traînées ;
//   2. statistiques sur une vignette 64×36 (une image sur trois) : luminance moyenne logarithmique, points noir et
//      blanc, carte de luminance locale lissée, gains « gray-world » limités (balance des blancs auto, en option) ;
//   3. tonalité : gain global + gain local (relève les ombres d'une zone sombre, ménage une zone claire), épaule douce
//      vers le blanc qui garde la teinte des LED au lieu de les brûler, chrominance atténuée dans les noirs profonds.
// Garde-fou : le coût réel par image (GPU compris) est mesuré ; s'il dépasse le budget, on passe au filtre 3×3, puis en
// 720p, puis on désactive avec un message. Sans WebGL2 : repli 2D (éclaircissement seul, sans débruitage).

export const ENH_DEFAULT = Object.freeze({ on: false, k: 0.6, wb: false });
export function normalizeEnh(o) {
  o = o && typeof o === 'object' ? o : {};
  const k = Number.isFinite(+o.k) && o.k !== null && o.k !== '' ? Math.min(1, Math.max(0, +o.k)) : ENH_DEFAULT.k;
  return { on: o.on === true, k: Math.round(k * 100) / 100, wb: o.wb === true };
}

// ---------- Calculs purs (testés en unitaire) ----------
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
export const srgbToLin = v => LIN[Math.max(0, Math.min(255, v | 0))];
const LW = [0.2126, 0.7152, 0.0722];

// Gains gray-world limités : moyenne pondérée des pixels peu saturés et ni noirs ni brûlés (les LED très colorées et
// l'écran ne doivent pas tirer toute l'image), chaque gain borné à 0,8–1,25 avant de conserver la luminance.
export function grayWorld(px, n) {
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < n; i++) {
    const r8 = px[i * 4], g8 = px[i * 4 + 1], b8 = px[i * 4 + 2], R = LIN[r8], G = LIN[g8], B = LIN[b8];
    const mx = Math.max(r8, g8, b8), mn = Math.min(r8, g8, b8);
    if (mx < 12 || mx > 240) continue;
    const sat = (mx - mn) / mx, wt = Math.max(0, 1 - sat * 1.4); // saturation lue en sRGB (comme l'œil)
    if (wt <= 0) continue;
    r += R * wt; g += G * wt; b += B * wt; w += wt;
  }
  if (w < n * 0.02 || r <= 0 || g <= 0 || b <= 0) return [1, 1, 1];
  const m = (r + g + b) / 3; let gr = m / r, gg = m / g, gb = m / b;
  const cl = x => Math.min(1.25, Math.max(0.8, x)); gr = cl(gr); gg = cl(gg); gb = cl(gb);
  const k = 1 / (LW[0] * gr + LW[1] * gg + LW[2] * gb); // luminance inchangée
  return [gr * k, gg * k, gb * k];
}

// Statistiques d'une vignette RGBA (w×h, déjà débruitée) → paramètres de tonalité.
// k : intensité 0…1. Renvoie { lavg, expo, gmax, black, white, gains, loc (Uint8Array w×h, racine cubique) }.
export function toneParams(px, w, h, k, { wb = false } = {}) {
  const n = w * h, gains = wb ? grayWorld(px, n) : [1, 1, 1];
  const L = new Float32Array(n); let logSum = 0;
  for (let i = 0; i < n; i++) {
    const l = LW[0] * LIN[px[i * 4]] * gains[0] + LW[1] * LIN[px[i * 4 + 1]] * gains[1] + LW[2] * LIN[px[i * 4 + 2]] * gains[2];
    L[i] = l; logSum += Math.log(Math.max(l, 1e-4));
  }
  const sorted = Float32Array.from(L).sort();
  const q = p => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const lavg = Math.exp(logSum / n);
  // point noir : le plancher de bruit, pour ne pas relever un voile gris
  const black = Math.min(q(0.02) * 0.9, lavg * 0.4, 0.012);
  // gain global : vise une luminance moyenne (log) de 0,15 linéaire (≈ 42 % en sRGB), modulé par l'intensité
  const KEY = 0.15, full = Math.min(20, Math.max(1, KEY / Math.max(lavg, 1e-4)));
  const gmax = 1 + 13 * k, expo = k > 0 ? Math.min(gmax, full ** (0.35 + 0.65 * k)) : 1;
  // point blanc (canal le plus fort) : les pixels les plus clairs, après gain
  let mx = new Float32Array(n);
  for (let i = 0; i < n; i++) mx[i] = Math.max(LIN[px[i * 4]] * gains[0], LIN[px[i * 4 + 1]] * gains[1], LIN[px[i * 4 + 2]] * gains[2]);
  mx.sort();
  const white = Math.max(1, mx[Math.round(0.995 * (n - 1))] * expo * 1.05);
  // carte locale : log-luminance lissée (deux passes de boîte 3×3 ≈ flou gaussien de ~3 cases)
  let a = Float32Array.from(L, v => Math.log(Math.max(v, 1e-4))), b2 = new Float32Array(n);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0, c = 0;
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; s += a[yy * w + xx]; c++; } }
      b2[y * w + x] = s / c;
    }
    [a, b2] = [b2, a];
  }
  const loc = new Uint8Array(n);
  for (let i = 0; i < n; i++) loc[i] = Math.max(1, Math.min(255, Math.round(Math.cbrt(Math.exp(a[i])) * 255)));
  return { lavg, expo, gmax, black, white, gains, loc };
}

// Mesures d'image (banc et tests) : luminance moyenne (0–255) et bruit = écart-type temporel moyen d'une zone fixe.
export function meanLuma(px) { let s = 0; const n = px.length / 4; for (let i = 0; i < px.length; i += 4) s += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]; return s / n; }

// ---------- Shaders ----------
const VS = `#version 300 es
in vec2 p; out vec2 vUv; void main(){ vUv = p * .5 + .5; gl_Position = vec4(p, 0., 1.); }`;
const FS_DEN = `#version 300 es
precision highp float;
uniform sampler2D uCur, uPrev; uniform vec2 uPx; uniform float uSig, uTw, uHasPrev, uChroma; uniform int uR;
in vec2 vUv; out vec4 o;
const vec3 W = vec3(.299, .587, .114);
void main(){
  vec3 c0 = texture(uCur, vUv).rgb;
  float is2 = 1. / (2. * uSig * uSig);
  vec3 acc = vec3(0.); float ws = 0.;
  for (int j = -2; j <= 2; j++) for (int i = -2; i <= 2; i++) {
    if (abs(i) > uR || abs(j) > uR) continue;
    vec3 c = texture(uCur, vUv + vec2(float(i), float(j)) * uPx).rgb;
    vec3 d = c - c0;
    float w = exp(-float(i * i + j * j) * .2 - dot(d, d) * is2);
    acc += c * w; ws += w;
  }
  vec3 sp = acc / ws;
  // chrominance : voisinage plus large (pas de 2,5 px), pondéré par la seule ressemblance de luminance
  float y0 = dot(sp, W); vec2 ch = vec2(0.); float wc = 0.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec3 c = texture(uCur, vUv + vec2(float(i), float(j)) * uPx * 2.5).rgb;
    float y = dot(c, W); float w = exp(-(y - y0) * (y - y0) * is2 * .5);
    ch += vec2(c.b - y, c.r - y) * w; wc += w;
  }
  ch /= wc;
  vec2 ch0 = vec2(sp.b - y0, sp.r - y0); ch = mix(ch0, ch, uChroma);
  float r = ch.y + y0, b = ch.x + y0, g = (y0 - W.r * r - W.b * b) / W.g;
  sp = clamp(vec3(r, g, b), 0., 1.);
  if (uHasPrev > .5) {
    vec3 pv = texture(uPrev, vUv).rgb;
    float diff = length(sp - pv);
    float mot = smoothstep(uSig * .5, uSig * 2., diff);
    sp = mix(sp, pv, uTw * (1. - mot));
  }
  o = vec4(sp, 1.);
}`;
const FS_TONE = `#version 300 es
precision highp float;
uniform sampler2D uDen, uLoc; uniform vec3 uGain;
uniform float uExpo, uLavg, uLocW, uBlack, uWhite, uGmax, uFlip, uToe;
in vec2 vUv; out vec4 o;
vec3 toLin(vec3 c){ return mix(c / 12.92, pow((c + .055) / 1.055, vec3(2.4)), step(.04045, c)); }
vec3 toSrgb(vec3 c){ c = clamp(c, 0., 1.); return mix(c * 12.92, 1.055 * pow(c, vec3(1. / 2.4)) - .055, step(.0031308, c)); }
void main(){
  vec2 uv = vec2(vUv.x, uFlip > .5 ? 1. - vUv.y : vUv.y);
  vec3 s = texture(uDen, uv).rgb;
  vec3 lin = max(toLin(s) * uGain - uBlack, 0.) / (1. - uBlack);
  float L = dot(lin, vec3(.2126, .7152, .0722));
  float la = texture(uLoc, uv).r; la = max(la * la * la, 1e-4);
  float e = clamp(uExpo * clamp(pow(uLavg / la, uLocW), .6, 2.5), 1., uGmax);
  // épaule sur le canal le plus fort (« max-RGB ») : identité jusqu'à 0,6, puis Reinhard étendu jusqu'au point blanc.
  // Teinte et saturation conservées : une LED rouge reste rouge au lieu de virer au blanc.
  float m0 = max(lin.r, max(lin.g, lin.b)), Mt = m0 * e, kn = .6, Mo = Mt;
  if (Mt > kn) { float x = (Mt - kn) / (1. - kn), wx = max((uWhite * e / uExpo - kn) / (1. - kn), 1.001); Mo = min(1., kn + (1. - kn) * x * (1. + x / (wx * wx)) / (1. + x)); }
  vec3 c = lin * (e * Mo / max(Mt, 1e-6));
  float Lo = dot(c, vec3(.2126, .7152, .0722));
  // noirs profonds : moins de chrominance (le bruit couleur y domine)
  c = mix(vec3(Lo), c, mix(.55, 1., smoothstep(.0, .03, Lo)));
  // pied de courbe : les noirs restent noirs (pas de voile gris sur les murs relevés)
  c *= pow(Lo / (Lo + .012), uToe);
  o = vec4(toSrgb(c), 1.);
}`;
const FS_STAT = `#version 300 es
precision highp float;
uniform sampler2D uDen; uniform vec2 uCell; in vec2 vUv; out vec4 o;
void main(){
  vec3 s = vec3(0.);
  for (int j = 0; j < 3; j++) for (int i = 0; i < 3; i++) s += texture(uDen, vUv + (vec2(float(i), float(j)) - 1.) * uCell * .33).rgb;
  o = vec4(s / 9., 1.);
}`;

// ---------- Moteur ----------
const SW = 64, SH = 36, STAT_EVERY = 3;
export const BUDGET_MS = 30; // au-delà (moyenne), on allège : 41 ms = une image à 24 i/s, on garde de la marge

export class Rehausse {
  constructor({ onFallback, guard = true } = {}) {
    this.cfg = { ...ENH_DEFAULT }; this.onFallback = onFallback; this.guard = guard;
    this.budget = typeof globalThis.__ccEnhBudget === 'number' ? globalThis.__ccEnhBudget : BUDGET_MS; // réglable pour les tests
    this.mode = 'off'; this.gl = null; this.cv = null; this.level = 0; this.cap = 1920;
    this.costs = []; this.frames = 0; this.fpsT = 0; this.fpsN = 0; this.fps = 0; this.cost = 0;
    this.lastVf = -1; this.vf = 0; this.watched = null; this.rvfcSeen = 0; this.params = null; this.n = 0; this.failed = false;
  }
  get active() { return this.cfg.on && !this.failed && this.mode !== 'off'; }
  get info() { return { mode: this.mode, level: this.level, side: this.side || 0, cost: this.cost, fps: this.fps, failed: this.failed }; }
  set(cfg) {
    const prev = this.cfg; this.cfg = normalizeEnh(cfg);
    if (!this.cfg.on) { this.mode = this.mode === 'off' ? 'off' : this.mode; return; }
    if (!prev.on || this.failed) { this.failed = false; this.level = 0; this.cap = 1920; this.costs = []; this.hasPrev = false; }
    if (this.mode === 'off') this.init();
  }
  init() {
    const cv = document.createElement('canvas'); cv.width = 2; cv.height = 2;
    let gl = null;
    try { gl = cv.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: true, powerPreference: 'high-performance', desynchronized: false }); } catch {}
    if (gl && this.initGl(gl)) { this.cv = cv; this.gl = gl; this.mode = 'webgl2';
      cv.addEventListener('webglcontextlost', e => { e.preventDefault(); this.gl = null; this.mode = 'off'; this.fail('perdu'); });
      return; }
    // repli 2D : éclaircissement seul
    this.cv = cv; this.c2 = cv.getContext('2d', { alpha: false }); this.mode = this.c2 ? '2d' : 'off';
    this.sm = document.createElement('canvas'); this.sm.width = 32; this.sm.height = 18; this.smx = this.sm.getContext('2d', { willReadFrequently: true });
    if (this.mode === 'off') this.fail('indispo');
  }
  initGl(gl) {
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = fs => { const p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.bindAttribLocation(p, 0, 'p'); gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); for (let i = 0; i < n; i++) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); } return { p, u }; };
    try {
      this.pDen = prog(FS_DEN); this.pTone = prog(FS_TONE); this.pStat = prog(FS_STAT);
      const vb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.f16 = !!gl.getExtension('EXT_color_buffer_float');
      const tex = () => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t); for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v); return t; };
      this.tIn = tex(); this.tDen = [tex(), tex()]; this.fbDen = [gl.createFramebuffer(), gl.createFramebuffer()];
      this.tStat = tex(); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, SW, SH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      this.fbStat = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbStat); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tStat, 0);
      this.tLoc = tex(); gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SW, SH, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(SW * SH).fill(80));
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.statPx = new Uint8Array(SW * SH * 4); this.dw = this.dh = 0; this.cur = 0;
      return true;
    } catch (e) { console.warn('rehaussement WebGL2', e); return false; }
  }
  sizeDen(w, h) {
    const gl = this.gl; if (this.dw === w && this.dh === h) return;
    this.dw = w; this.dh = h; this.hasPrev = false; this.cv.width = w; this.cv.height = h;
    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.tDen[i]);
      if (this.f16) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbDen[i]); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tDen[i], 0);
      if (this.f16 && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { this.f16 = false; this.dw = 0; return this.sizeDen(w, h); }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  // Nouvelle image caméra ? (requestVideoFrameCallback : on ne retraite pas deux fois la même image)
  newFrame(v) {
    if (!v.requestVideoFrameCallback) return true;
    if (this.watched !== v) {
      this.watched = v; this.vf++;
      const tick = () => { this.vf++; this.rvfcSeen = performance.now(); if (this.watched === v) v.requestVideoFrameCallback(tick); };
      v.requestVideoFrameCallback(tick);
    }
    if (performance.now() - this.rvfcSeen > 400) return performance.now() - (this.lastT || 0) > 30; // pas de rappel : au temps
    if (this.vf === this.lastVf) return false;
    this.lastVf = this.vf; return true;
  }
  // src : <video> (ou canvas). maxSide : côté long voulu. Renvoie le canvas rehaussé (ou null si inactif).
  render(src, maxSide = 1920, { force = false } = {}) {
    if (!this.active) return null;
    const vw = src.videoWidth || src.width, vh = src.videoHeight || src.height; if (!vw || !vh) return null;
    const s = Math.min(1, Math.min(maxSide, this.cap) / Math.max(vw, vh));
    const w = Math.round(vw * s / 2) * 2, h = Math.round(vh * s / 2) * 2;
    if (!force && !this.newFrame(src) && this.cv.width === w && this.cv.height === h) return this.cv;
    const t0 = performance.now(); this.lastT = t0;
    let synced = false;
    try {
      if (this.mode === 'webgl2') synced = this.renderGl(src, w, h);
      else this.render2d(src, w, h);
    } catch (e) { console.warn('rehaussement', e); this.fail('erreur'); return null; }
    this.side = Math.max(w, h);
    // fps traité
    this.fpsN++; if (t0 - this.fpsT >= 1000) { this.fps = Math.round(this.fpsN * 1000 / (t0 - this.fpsT || 1)); this.fpsN = 0; this.fpsT = t0; }
    if (synced || this.mode === '2d') {
      const dt = performance.now() - t0; this.costs.push(dt); if (this.costs.length > 20) this.costs.shift();
      this.cost = this.costs.reduce((a, b) => a + b, 0) / this.costs.length;
      if (this.guard && this.costs.length >= 12 && this.cost > this.budget) this.lighten();
    }
    return this.cv;
  }
  lighten() {
    this.costs = [];
    if (this.mode === 'webgl2' && this.level === 0) { this.level = 1; return; } // filtre 3×3
    if (this.cap > 1280) { this.cap = 1280; this.level = Math.max(this.level, 2); return; } // 720p
    this.fail('lent');
  }
  renderGl(src, w, h) {
    const gl = this.gl, k = this.cfg.k; this.sizeDen(w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.tIn);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.viewport(0, 0, w, h);
    // 1. débruitage → tDen[cur]
    const cur = this.cur ^ 1, prev = this.cur;
    const D = this.pDen; gl.useProgram(D.p);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbDen[cur]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tIn); gl.uniform1i(D.u.uCur, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tDen[prev]); gl.uniform1i(D.u.uPrev, 1);
    gl.uniform2f(D.u.uPx, 1 / w, 1 / h); gl.uniform1f(D.u.uSig, 0.02 + 0.05 * k); gl.uniform1f(D.u.uTw, 0.4 + 0.45 * k);
    gl.uniform1f(D.u.uHasPrev, this.hasPrev ? 1 : 0); gl.uniform1f(D.u.uChroma, 0.4 + 0.6 * k); gl.uniform1i(D.u.uR, this.level >= 1 ? 1 : 2);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.cur = cur; this.hasPrev = true;
    // 2. tonalité → canvas (avec les paramètres de la mesure précédente ; la toute première est faite avant)
    if (!this.params) this.stats(cur, k);
    gl.viewport(0, 0, w, h);
    const P = this.params, T = this.pTone; gl.useProgram(T.p); gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tDen[cur]); gl.uniform1i(T.u.uDen, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tLoc); gl.uniform1i(T.u.uLoc, 1);
    gl.uniform3fv(T.u.uGain, P.gains); gl.uniform1f(T.u.uExpo, P.expo); gl.uniform1f(T.u.uLavg, P.lavg); gl.uniform1f(T.u.uLocW, 0.35 * k); gl.uniform1f(T.u.uToe, 0.5 * k);
    gl.uniform1f(T.u.uBlack, P.black * k); gl.uniform1f(T.u.uWhite, P.white); gl.uniform1f(T.u.uGmax, P.gmax); gl.uniform1f(T.u.uFlip, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    // 3. statistiques une image sur trois : la lecture (readPixels) attend la fin de tout le travail GPU de l'image,
    //    ce qui donne aussi son coût réel.
    if (this.n++ % STAT_EVERY === 0) { this.stats(cur, k); return true; }
    return false;
  }
  stats(cur, k) {
    const gl = this.gl, St = this.pStat; gl.useProgram(St.p); gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbStat); gl.viewport(0, 0, SW, SH);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tDen[cur]); gl.uniform1i(St.u.uDen, 0); gl.uniform2f(St.u.uCell, 1 / SW, 1 / SH);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, SW, SH, gl.RGBA, gl.UNSIGNED_BYTE, this.statPx);
    const p = toneParams(this.statPx, SW, SH, k, { wb: this.cfg.wb });
    // lissage temporel des paramètres globaux (pas de pompage d'exposition)
    if (this.params) { for (const key of ['lavg', 'expo', 'black', 'white']) p[key] = this.params[key] * 0.8 + p[key] * 0.2; p.gains = p.gains.map((g, i) => this.params.gains[i] * 0.85 + g * 0.15); }
    this.params = p;
    gl.bindTexture(gl.TEXTURE_2D, this.tLoc); gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, SW, SH, gl.RED, gl.UNSIGNED_BYTE, p.loc);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  render2d(src, w, h) {
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
    if (!this.params || this.n++ % 10 === 0) {
      this.smx.drawImage(src, 0, 0, 32, 18);
      const px = this.smx.getImageData(0, 0, 32, 18).data;
      const p = toneParams(px, 32, 18, this.cfg.k, { wb: false });
      this.params = this.params ? { ...p, expo: this.params.expo * 0.7 + p.expo * 0.3 } : p;
    }
    const g = Math.min(this.params.gmax, this.params.expo);
    // gain linéaire g ≈ luminosité sRGB g^(1/2,2) ; léger contraste pour ne pas délaver
    this.c2.filter = `brightness(${(g ** (1 / 2.2)).toFixed(3)}) contrast(1.04) saturate(0.92)`;
    this.c2.drawImage(src, 0, 0, w, h); this.c2.filter = 'none';
  }
  fail(why) {
    this.failed = true;
    this.onFallback?.(why === 'lent' ? 'Rehaussement faible lumière désactivé : cet appareil est trop lent, même en 720p.'
      : why === 'perdu' ? 'Rehaussement faible lumière arrêté : la carte graphique a été réinitialisée. Réactive-le dans les réglages de la caméra.'
        : 'Rehaussement faible lumière indisponible sur cet appareil.');
  }
}
