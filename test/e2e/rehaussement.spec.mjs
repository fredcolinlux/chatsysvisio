import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, waitMedia } from './helpers.mjs';

// Rehaussement faible lumière, aperçu en miroir / champ complet, zoom (1.11).
// La machine de test n'a pas de carte graphique (WebGL2 logiciel, SwiftShader) : le garde-fou de performance est
// relâché ici (__ccEnhBudget), sauf dans le test qui le vérifie.
const relax = () => { window.__ccEnhBudget = 1e6; };
const enhState = page => page.evaluate(() => { const S = window.__ccState; return { on: !!S.camfx.enh.on, active: !!S.enh?.active, mode: S.enh?.info.mode, fps: S.enh?.info.fps || 0, saved: JSON.parse(localStorage.getItem('csv-cam') || '{}').enh || null }; });

test('rehaussement : désactivé par défaut, interrupteur, intensité, balance des blancs, enregistré, aperçu traité', async ({ page }) => {
  await page.addInitScript(relax);
  const url = await createRoom(page, 'Rehaussement');
  await page.goto(url);
  await expect(page.locator('#selfPreview video.selfvid')).toBeVisible({ timeout: 10_000 });
  expect((await enhState(page)).on).toBe(false);
  await page.click('.camopen');
  const box = page.locator('.modal #camField');
  const sw = box.locator('.camenh');
  await expect(sw).toHaveAttribute('aria-checked', 'false');
  await expect(box.locator('.enhset')).toBeHidden();
  await sw.click();
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await expect(box.locator('.enhset')).toBeVisible();
  await expect.poll(async () => (await enhState(page)).active).toBe(true);
  expect((await enhState(page)).mode).toBe('webgl2');
  // l'aperçu montre l'image rehaussée (canvas), plus la vidéo brute
  await expect(page.locator('#selfPreview canvas.selfcanvas')).toBeVisible();
  await expect(page.locator('#selfPreview video.selfvid')).toBeHidden();
  await expect.poll(async () => (await enhState(page)).fps, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(box.locator('.enhnow')).toContainText('WebGL2');
  await expect(box.locator('.enhnow')).toContainText('ms par image');
  // intensité et balance des blancs
  await box.locator('input.enhk').fill('80');
  await expect(box.locator('.enhkval')).toHaveText('80 %');
  await box.locator('.camenhwb').click();
  await expect(box.locator('.camenhwb')).toHaveAttribute('aria-checked', 'true');
  expect((await enhState(page)).saved).toEqual({ on: true, k: 0.8, wb: true });
  // l'image est réellement éclaircie : canvas d'aperçu plus lumineux que la vidéo brute
  const lum = await page.evaluate(() => {
    const m = el => { const c = document.createElement('canvas'); c.width = 64; c.height = 36; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(el, 0, 0, 64, 36); const d = g.getImageData(0, 0, 64, 36).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += .299 * d[i] + .587 * d[i + 1] + .114 * d[i + 2]; return s / (d.length / 4); };
    return { raw: m(window.__ccState.video), enh: m(document.querySelector('#selfPreview canvas.selfcanvas')) };
  });
  expect(lum.enh).toBeGreaterThan(0); expect(Number.isFinite(lum.raw)).toBe(true);
  // rechargement : réactivé tout seul
  await page.reload();
  await expect.poll(async () => (await enhState(page)).active, { timeout: 10_000 }).toBe(true);
  // arrêt : retour à la vidéo brute
  await page.click('.camopen'); await page.locator('.modal .camenh').click();
  await expect.poll(async () => (await enhState(page)).active).toBe(false);
  await expect(page.locator('#selfPreview video.selfvid')).toBeVisible();
  expect((await enhState(page)).saved.on).toBe(false);
});

test('rehaussement : en appel, l\'image envoyée passe par le rehaussement, combiné au flou', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  await a.addInitScript(relax);
  await a.goto('/'); await a.evaluate(() => { localStorage.setItem('csv-cam', JSON.stringify({ enh: { on: true, k: 0.6 } })); localStorage.setItem('cc-bg', 'blur'); });
  const url = await createRoom(a, 'Rehaussement en appel');
  await joinRoom(a, url, 'Alice'); await joinRoom(b, url, 'Bruno');
  await waitMedia(b, { video: 10, audio: 0 });
  await expect.poll(() => a.evaluate(() => window.__ccState.enh?.active && window.__ccState.enh.info.fps > 0), { timeout: 20_000 }).toBe(true);
  // flou actif : il compose à partir du canvas rehaussé (une seule chaîne, pas deux captures)
  const chain = await a.evaluate(() => { const S = window.__ccState; return { fx: !!S.effects?.active, enh: S.enh.info.mode }; });
  expect(chain.enh).toBe('webgl2');
  if (chain.fx) expect(await a.evaluate(() => window.__ccState.effects.out.width > 0)).toBe(true);
  // et Bruno continue de recevoir des images
  const n0 = await b.evaluate(() => Object.values(window.__cc.decoded.video)[0] || 0);
  await expect.poll(() => b.evaluate(() => Object.values(window.__cc.decoded.video)[0] || 0), { timeout: 10_000 }).toBeGreaterThan(n0 + 5);
  await ca.close(); await cb.close();
});

test('rehaussement : appareil trop lent → allégé, puis désactivé avec un message', async ({ page }) => {
  await page.addInitScript(() => { window.__ccEnhBudget = 0.001; });
  const url = await createRoom(page, 'Rehaussement lent');
  await page.goto(url);
  await expect(page.locator('#selfPreview video.selfvid')).toBeVisible({ timeout: 10_000 });
  await page.click('.camopen'); await page.locator('.modal .camenh').click();
  await expect(page.locator('.toast, [role=status]').filter({ hasText: 'trop lent' }).first()).toBeVisible({ timeout: 20_000 });
  const st = await enhState(page);
  expect(st.active).toBe(false); expect(st.saved.on).toBe(false);
  await expect(page.locator('.modal .camenh')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('#selfPreview video.selfvid')).toBeVisible();
});

test('aperçu de soi : miroir et champ complet par défaut, options, envoi jamais inversé ; mode natif du capteur', async ({ page }) => {
  const url = await createRoom(page, 'Aperçu');
  await page.goto(url);
  const v = page.locator('#selfPreview video.selfvid');
  await expect(v).toBeVisible({ timeout: 10_000 });
  const css = () => v.evaluate(el => ({ fit: getComputedStyle(el).objectFit, tr: getComputedStyle(el).transform }));
  expect(await css()).toEqual({ fit: 'contain', tr: 'matrix(-1, 0, 0, 1, 0, 0)' });
  // la caméra est ouverte sans recadrage du navigateur quand un mode natif convient
  const rm = await page.evaluate(() => window.__ccState.stream.getVideoTracks()[0].getSettings().resizeMode);
  expect(rm).toBe('none');
  await page.click('.camopen');
  await page.locator('.modal .cammirror').click();
  await expect.poll(async () => (await css()).tr).toBe('none');
  await page.locator('.modal .camfull').click();
  await expect.poll(async () => (await css()).fit).toBe('cover');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('csv-cam')));
  expect(saved.mirror).toBe(false); expect(saved.fill).toBe(true);
  // en appel, seul dans le salon : la vignette de soi suit les mêmes options
  await page.locator('.modal .cammirror').click(); await page.locator('.modal .camfull').click();
  await page.keyboard.press('Escape');
  await joinRoom(page, url, 'Alice');
  const me = page.locator('.tile.me video.selfvid');
  await expect(me).toBeVisible({ timeout: 15_000 });
  expect(await me.evaluate(el => ({ fit: getComputedStyle(el).objectFit, tr: getComputedStyle(el).transform }))).toEqual({ fit: 'contain', tr: 'matrix(-1, 0, 0, 1, 0, 0)' });
});

// Caméra à zoom simulée (la fausse caméra de Chrome n'en a pas) : le zoom n'apparaît qu'avec getUserMedia({ zoom: true }),
// comme une vraie webcam UVC sous Chrome (autorisation « déplacer la caméra »). Zoom laissé à ×1,3 par « Logi Tune ».
function ptzCam() {
  const ptz = new WeakSet(), z = new WeakMap(), md = navigator.mediaDevices, gum = md.getUserMedia.bind(md), P = MediaStreamTrack.prototype;
  const gc = P.getCapabilities, gs = P.getSettings, ac = P.applyConstraints;
  md.getUserMedia = async c => { const s = await gum(JSON.parse(JSON.stringify(c, (k, v) => k === 'zoom' ? undefined : v))); if (c?.video?.zoom) s.getVideoTracks().forEach(t => { ptz.add(t); z.set(t, 130); }); return s; };
  P.getCapabilities = function () { const r = gc.call(this); return ptz.has(this) ? { ...r, zoom: { min: 100, max: 500, step: 1 } } : r; };
  P.getSettings = function () { const r = gs.call(this); return ptz.has(this) ? { ...r, zoom: z.get(this) } : r; };
  P.applyConstraints = function (c = {}) { if (ptz.has(this)) for (const a of c.advanced || []) if ('zoom' in a) z.set(this, a.zoom); const adv = (c.advanced || []).filter(a => !('zoom' in a)); const { advanced, ...rest } = c; return ac.call(this, adv.length ? { ...rest, advanced: adv } : rest); };
}
test('zoom : sur demande, réglable, « Champ complet » revient au minimum', async ({ page }) => {
  await page.addInitScript(ptzCam);
  const url = await createRoom(page, 'Zoom');
  await page.goto(url);
  await expect(page.locator('#selfPreview video.selfvid')).toBeVisible({ timeout: 10_000 });
  await page.click('.camopen');
  const ask = page.locator('.modal #camPtz');
  await expect(ask).toBeVisible();
  await ask.click();
  const zoom = page.locator('.modal input.camr[data-k="zoom"]');
  await expect(zoom).toBeVisible({ timeout: 10_000 });
  const cap = await page.evaluate(() => window.__ccState.stream.getVideoTracks()[0].getCapabilities().zoom);
  await zoom.fill(String(cap.max));
  await expect.poll(() => page.evaluate(() => window.__ccState.stream.getVideoTracks()[0].getSettings().zoom), { timeout: 5000 }).toBe(cap.max);
  await expect(page.locator('.modal .camzoomhint')).toContainText('recadrée');
  await page.locator('.modal .camzoom .btn').click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('csv-cam')).ptz)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.__ccState.stream.getVideoTracks()[0].getSettings().zoom), { timeout: 5000 }).toBe(cap.min);
  await expect(page.locator('.modal .camzoomhint')).toContainText('Champ complet');
});
