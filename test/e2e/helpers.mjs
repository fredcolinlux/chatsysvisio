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
