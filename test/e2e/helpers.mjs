import { expect } from '@playwright/test';
// Salon privé : chiffré de bout en bout par défaut (lien …/r/slug#k=…) ; e2ee:false pour un salon TLS seulement.
export async function createRoom(page, name, { password, isPublic, e2ee = true } = {}) {
  await page.goto('/');
  await page.fill('#roomName', name);
  if (isPublic) await page.click('#chipPrivate');
  if (password) { await page.click('#chipPw'); await page.fill('#roomPw', password); }
  if (!e2ee && !isPublic) await page.click('#chipE2ee');
  await page.click('#go');
  await page.waitForURL(/\/r\/[a-z0-9-]+(#k=[A-Za-z0-9_-]{43})?$/, { timeout: 20_000 });
  return page.url();
}
// Ajoute une requête avant le fragment #k= (sinon elle finirait dans la clé)
export const withQuery = (url, q) => { const i = url.indexOf('#'); return i < 0 ? url + q : url.slice(0, i) + q + url.slice(i); };
export async function joinRoom(page, url, name, password) {
  if (page.url() !== url) await page.goto(url);
  await page.fill('#name', name);
  if (password !== undefined) await page.fill('#pw', password);
  await page.click('#joinBtn');
}
export async function waitMedia(page, { video = 10, audio = 10, peers = 1 } = {}) {
  await expect.poll(async () => page.evaluate(({ video, audio, peers }) => {
    const s = window.__cc; if (!s) return 'pas de stats';
    const v = Object.values(s.decoded.video).filter(n => n >= video).length;
    const a = Object.values(s.decoded.audio).filter(n => n >= audio).length;
    return v >= peers && (audio === 0 || a >= peers) ? 'ok' : `video=${JSON.stringify(s.decoded.video)} audio=${JSON.stringify(s.decoded.audio)} err=${s.errors.slice(-3)}`;
  }, { video, audio, peers }), { timeout: 30_000, intervals: [500] }).toBe('ok');
}
// Crête du son réellement joué par la page (AnalyserNode en sortie du lecteur) sur une durée donnée.
export const outputPeak = (page, ms = 1500) => page.evaluate(async ms => {
  let m = 0; const t = performance.now();
  while (performance.now() - t < ms) { m = Math.max(m, window.__ccState?.audio?.outputPeak?.() || 0); await new Promise(r => setTimeout(r, 25)); }
  return m;
}, ms);
// Attend que le son d'en face soit audible (crête > seuil) ; message détaillé sinon.
export async function expectAudible(page, min = 0.02) {
  await expect.poll(async () => {
    const p = await outputPeak(page, 1200); if (p > min) return 'audible';
    return page.evaluate(p => `crête=${p.toFixed(4)} ctx=${window.__ccState?.audio?.ctx?.state} reçus=${JSON.stringify(window.__cc.recv.audio)} décodés=${JSON.stringify(window.__cc.decoded.audio)} e2ee=${JSON.stringify(window.__cc.e2ee || null)} err=${window.__cc.errors.slice(-3)}`, p);
  }, { timeout: 30_000, intervals: [300] }).toBe('audible');
}

// Rend 1,5 s d'un signal de test à travers MicChain et renvoie le niveau RMS (dBFS) de la dernière seconde.
export async function measureMicFx(page, fx, signal) {
  return page.evaluate(async ({ fx, signal }) => {
    const { MicChain } = await import('/js/micfx.js');
    const sr = 48000, n = Math.round(sr * 1.5), ctx = new OfflineAudioContext(1, n, sr);
    await ctx.audioWorklet.addModule('/js/worklets.js');
    const chain = new MicChain(ctx); const st = await chain.set(fx);
    const buf = ctx.createBuffer(1, n, sr), x = buf.getChannelData(0);
    let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 * 2 - 1;
    const A = db => 10 ** (db / 20);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      if (signal.kind === 'tone') x[i] = A(signal.db) * Math.sin(2 * Math.PI * signal.f * t);
      else if (signal.kind === 'noise') x[i] = A(signal.db) * rnd() * 1.7;
      else if (signal.kind === 'voice') { // voyelle synthétique (harmoniques de 140 Hz, syllabes à 4 Hz) + bruit faible
        let v = 0; for (let k = 1; k <= 20; k++) v += Math.sin(2 * Math.PI * 140 * k * t) / k;
        x[i] = A(signal.db) * 0.6 * v * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t)) + A(signal.noiseDb) * rnd() * 1.7;
      }
    }
    const rms = (a, from) => { let s = 0; for (let i = from; i < a.length; i++) s += a[i] * a[i]; return 10 * Math.log10(s / (a.length - from) + 1e-20); };
    const inDb = rms(x, sr / 2); // avant le rendu (Firefox détache le tampon une fois confié au moteur audio)
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(chain.input); chain.output.connect(ctx.destination); src.start();
    // RNNoise s'instancie de façon asynchrone dans le worklet : on laisse le temps au wasm de démarrer.
    // (Firefox : pas de suspend() hors ligne ; on attend avant de lancer le rendu.)
    if (ctx.suspend) ctx.suspend(0.05).then(() => setTimeout(() => ctx.resume(), 600)); else await new Promise(r => setTimeout(r, 800));
    const out = (await ctx.startRendering()).getChannelData(0);
    return { inDb, outDb: rms(out, sr / 2), st: { ...st } };
  }, { fx, signal });
}

// Autotune : rend un son à travers MicChain (rendu hors ligne, CSP de la page d'appel) et mesure en sortie la hauteur
// (passages par zéro sur la dernière demi-seconde) et le retard ajouté (début du son). signal : { f, sec, kind }.
export async function measureTune(page, fx, { f = 450, sec = 1.5, kind = 'sine', sr = 48000 } = {}) {
  return page.evaluate(async ({ fx, f, sec, kind, sr }) => {
    const { MicChain } = await import('/js/micfx.js');
    const n = Math.round(sr * sec), lead = Math.round(sr * 0.3), ctx = new OfflineAudioContext(1, n, sr);
    const chain = new MicChain(ctx); const st = await chain.set(fx);
    const buf = ctx.createBuffer(1, n, sr), x = buf.getChannelData(0);
    let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 * 2 - 1;
    for (let i = lead; i < n; i++) x[i] = kind === 'noise' ? 0.2 * rnd() : 0.3 * Math.sin(2 * Math.PI * f * (i - lead) / sr);
    const xin = Float32Array.from(x); // copie (Firefox détache le tampon confié au moteur audio)
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(chain.input); chain.output.connect(ctx.destination); src.start();
    if (ctx.suspend) ctx.suspend(0.05).then(() => setTimeout(() => ctx.resume(), 300)); else await new Promise(r => setTimeout(r, 500));
    const y = (await ctx.startRendering()).getChannelData(0);
    let first = -1, last = -1, z = 0;
    for (let i = n - Math.round(sr * 0.5); i < n; i++) if (y[i - 1] < 0 && y[i] >= 0) { const t = i - 1 + -y[i - 1] / (y[i] - y[i - 1]); if (first < 0) first = t; last = t; z++; }
    const on = a => { for (let i = 0; i < a.length; i++) if (Math.abs(a[i]) > 0.02) return i; return -1; };
    const L = on(y) - on(xin);
    let maxDiff = 0; if (kind === 'noise') for (let i = Math.max(0, L); i < n; i++) maxDiff = Math.max(maxDiff, Math.abs(y[i] - xin[i - L]));
    return { hz: (z - 1) * sr / (last - first), latencyMs: L / sr * 1000, maxDiff, st: { ...st }, chainMs: chain.tuneLatencyMs };
  }, { fx, f, sec, kind, sr });
}

// Isolateur de voix (1.9) : voix de synthèse + musique (ou voix lointaine) rendues à travers MicChain dans la page
// d'appel (rendu hors ligne, CSP de la page). Renvoie la sortie et les mesures : latence (corrélation avec ta voix),
// niveau de la musique pendant tes pauses, gain de ta voix seule, état, temps de chargement.
export async function measureIso(page, fx, { sr = 48000, sec = 5, other = 'musique', relDb = -6 } = {}) {
  const { parole, musique, lointain } = await import('../../scripts/voix-synthese.mjs');
  const v = parole(sr, sec, { seed: 7 }), o = other === 'musique' ? musique(sr, sec) : other === 'lointaine' ? lointain(sr, parole(sr, sec, { f0: 190, seed: 42 }), { gainDb: 0, rt60: 0.3 }) : new Float32Array(v.length);
  const dbE = a => { let e = 0; for (const q of a) e += q * q; return 10 * Math.log10(e / a.length + 1e-20); };
  const k = other === 'aucun' ? 0 : 10 ** ((relDb - (dbE(o) - dbE(v))) / 20), mix = v.map((q, i) => q + k * o[i]);
  const r = await page.evaluate(async ({ fx, x, v, sr }) => {
    const { MicChain } = await import('/js/micfx.js');
    const n = x.length, run = async (sig, f) => {
      const ctx = new OfflineAudioContext(1, n, sr), chain = new MicChain(ctx), t0 = performance.now();
      const st = await chain.set(f); const loadMs = performance.now() - t0;
      const b = ctx.createBuffer(1, n, sr); b.getChannelData(0).set(sig);
      const s = ctx.createBufferSource(); s.buffer = b; s.connect(chain.input); chain.output.connect(ctx.destination); s.start();
      const t1 = performance.now(); const y = Float32Array.from((await ctx.startRendering()).getChannelData(0));
      return { y, st: { ...st }, loadMs, renderMs: performance.now() - t1, isoMs: chain.isoLatencyMs, err: chain.isoError, startMs: chain.isoStartMs };
    };
    const a = await run(Float32Array.from(x), fx), solo = await run(Float32Array.from(v), fx);
    return { y: Array.from(a.y), ySolo: Array.from(solo.y), st: a.st, loadMs: a.loadMs, renderMs: a.renderMs, isoMs: a.isoMs, err: a.err, startMs: a.startMs };
  }, { fx, x: Array.from(mix), v: Array.from(v), sr });
  const y = Float32Array.from(r.y), ys = Float32Array.from(r.ySolo);
  let best = -1, L = 0; for (let d = 0; d < Math.round(sr * 0.06); d++) { let c = 0; for (let i = 0; i + d < v.length; i += 3) c += v[i] * ys[i + d]; if (c > best) { best = c; L = d; } }
  const mask = new Uint8Array(v.length); let s = 0; for (let i = 0; i < v.length; i++) { s = Math.max(Math.abs(v[i]), s * 0.9995); mask[i] = s < 1e-3; }
  let pi = 0, po = 0; for (let i = 0; i + L < v.length; i++) if (mask[i]) { pi += mix[i] ** 2; po += y[i + L] ** 2; }
  let vi = 0, vo = 0; for (let i = 0; i + L < v.length; i++) { vi += v[i] ** 2; vo += ys[i + L] ** 2; }
  return { ...r, y: undefined, ySolo: undefined, latencyMs: L / sr * 1000, pausesDb: 10 * Math.log10(po / pi), voiceDb: 10 * Math.log10(vo / vi) };
}
