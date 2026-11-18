import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, waitMedia } from './helpers.mjs';

// Réglages de la caméra (1.10). La caméra simulée de Chrome expose exposureMode / exposureTime / focus et 20 i/s max.
const track = page => page.evaluate(() => { const t = window.__ccState.stream?.getVideoTracks()[0]; const s = t?.getSettings() || {}; return { fps: s.frameRate, mode: s.exposureMode, time: s.exposureTime, w: s.width }; });

test('caméra : panneau dans le salon d\'attente, exposition manuelle, faible lumière, débit HD, réinitialisation', async ({ page }) => {
  const url = await createRoom(page, 'Réglages caméra');
  await page.goto(url);
  await expect.poll(async () => (await track(page)).w || 0, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.click('.camopen');
  const box = page.locator('.modal #camField');
  await expect(box).toBeVisible();
  await expect(box.locator('.camnow')).toContainText('i/s');
  // exposition : Auto → Manuel, le temps d'exposition apparaît et s'applique à la piste
  const seg = box.locator('.cammode[data-k="exposureMode"]');
  await seg.locator('button[data-m="manual"]').click();
  await expect.poll(async () => (await track(page)).mode, { timeout: 5000 }).toBe('manual');
  const slider = box.locator('input.camr[data-k="exposureTime"]');
  await expect(slider).toBeVisible();
  await slider.fill('0'); // minimum du curseur logarithmique = 10 (unités de 100 µs) sur la caméra simulée
  await expect.poll(async () => (await track(page)).time, { timeout: 5000 }).toBe(10);
  // faible lumière : 15 i/s demandés à la caméra, enregistré
  await box.locator('.camlow').click();
  await expect(box.locator('.camlow')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => Math.round((await track(page)).fps), { timeout: 5000 }).toBe(15);
  // débit HD
  await box.locator('.camrate button[data-r="high"]').click();
  await expect(box.locator('.camrateval')).toContainText('4 Mbit/s');
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('csv-cam')));
  expect(saved.lowLight).toBe(true); expect(saved.rate).toBe('high');
  const dev = Object.values(saved.dev)[0]; expect(dev.set.exposureMode).toBe('manual'); expect(dev.set.exposureTime).toBe(10);
  expect(dev.def.exposureMode).toBe('manual'); // valeur d'origine de la caméra simulée, relevée avant modification
  // rechargement : réglages réappliqués à l'ouverture de la caméra
  await page.reload();
  await expect.poll(async () => { const t = await track(page); return `${Math.round(t.fps)}/${t.time}`; }, { timeout: 10_000 }).toBe('15/10');
  // réinitialiser : retour aux valeurs d'origine et à la cadence normale
  await page.click('.camopen'); await page.click('.modal .camfoot .btn');
  await expect.poll(async () => { const t = await track(page); return `${Math.round(t.fps)}/${t.time}`; }, { timeout: 10_000 }).toBe('20/50');
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem('csv-cam')));
  expect(after.lowLight).toBe(false); expect(Object.values(after.dev)[0].set).toEqual({});
});

test('caméra : débit HD en tête-à-tête au plafond, faible lumière → couche HD à 15 i/s', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  await a.goto('/'); await a.evaluate(() => { localStorage.setItem('cc-quality', '1080p'); localStorage.setItem('csv-cam', JSON.stringify({ lowLight: true, rate: 'auto' })); });
  const url = await createRoom(a, 'Débit HD');
  await joinRoom(a, url, 'Alice'); await joinRoom(b, url, 'Bruno');
  await waitMedia(b, { video: 10, audio: 0 });
  await expect.poll(() => a.evaluate(() => window.__cc.hd?.kbps), { timeout: 20_000 }).toBe(4000);
  expect(await a.evaluate(() => window.__cc.hd.fps)).toBe(15);
  // menu « … » → Réglages de la caméra pendant l'appel ; Standard → plancher serveur (2,5 Mbit/s)
  await a.click('#dMore'); await a.click('.menuitem:has-text("Réglages de la caméra")');
  await a.click('.modal .camrate button[data-r="std"]');
  await expect.poll(() => a.evaluate(() => window.__cc.hd?.kbps), { timeout: 10_000 }).toBe(2500);
  await ca.close(); await cb.close();
});
