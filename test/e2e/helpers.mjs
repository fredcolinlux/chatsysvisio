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
