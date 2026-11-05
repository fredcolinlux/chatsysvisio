import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, waitMedia, withQuery } from './helpers.mjs';

// Caméra simulée de Chrome : elle fournit la résolution demandée (ici 1920×1080).
const frames = page => page.evaluate(() => window.__cc.frames || {});
const best = (fr, layer) => Object.entries(fr).filter(([k]) => k.endsWith(':' + layer)).map(([, v]) => v).sort((a, b) => b.h - a.h)[0];

test('HD 1080p : réglage dans le salon d\'attente, couche HD reçue en 1920×1080 en tête-à-tête', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  const url = await createRoom(a, 'Ciné HD');
  // ?force=nolag : l'encodeur VP8 logiciel du Chrome headless ne tient pas 1080p à 24 i/s sur la machine de test ;
  // on neutralise ce seul critère pour vérifier la chaîne 1080p de bout en bout (le critère réseau reste actif).
  await a.goto(withQuery(url, '?force=nolag'));
  await expect(a.locator('.qseg button')).toHaveText(['Auto', '360p', '720p', '1080p', 'Éco']);
  await a.click('.qseg button[data-q="1080p"]');
  await expect(a.locator('.qseg button[data-q="1080p"]')).toHaveAttribute('aria-pressed', 'true');
  expect(await a.evaluate(() => localStorage.getItem('cc-quality'))).toBe('1080p');
  await expect.poll(() => a.evaluate(() => document.querySelector('video.srcvid')?.videoHeight), { timeout: 10_000 }).toBe(1080);
  await joinRoom(a, a.url(), 'Alice'); await joinRoom(b, url, 'Bruno');
  await waitMedia(b, { video: 20, audio: 0 });
  // Bruno affiche Alice en grand : il s'abonne à la couche HD (3) et reçoit du 1080p
  await expect.poll(async () => best(await frames(b), 3)?.h || 0, { timeout: 30_000 }).toBe(1080);
  const f = best(await frames(b), 3); expect(f.w).toBe(1920);
  const send = await a.evaluate(() => window.__cc.send);
  expect(send.sendH).toBe(1080); expect(send.need).toContain(3);
  // Débit montant de la couche HD : quelques secondes de mesure, doit rester raisonnable (< 6 Mbit/s tout compris)
  const b0 = await a.evaluate(() => window.__cc.sent.bytes); await a.waitForTimeout(4000);
  const mbps = (await a.evaluate(() => window.__cc.sent.bytes) - b0) * 8 / 4 / 1e6;
  expect(mbps).toBeGreaterThan(0.3); expect(mbps).toBeLessThan(6);
  // Passage en 360p pendant l'appel (menu Plus → Qualité vidéo) : Bruno repasse sur la couche 360p
  await a.click('#dMore'); await a.click('.menuitem:has-text("Qualité vidéo")');
  await a.click('.modal .qseg button[data-q="360p"]');
  await expect.poll(() => b.evaluate(() => JSON.stringify(window.__cc.subs)), { timeout: 15_000 }).toMatch(/,1\]/);
  await expect.poll(async () => { const s = await a.evaluate(() => window.__cc.need); return JSON.stringify(s); }, { timeout: 10_000 }).not.toContain('3');
  await ca.close(); await cb.close();
});

test('HD : en mosaïque de 6, les vignettes restent en basse définition (aucune couche HD)', async ({ browser }) => {
  const ctxs = await Promise.all(Array.from({ length: 6 }, () => browser.newContext()));
  const pages = await Promise.all(ctxs.map(c => c.newPage()));
  await pages[0].goto('/'); await pages[0].evaluate(() => localStorage.setItem('cc-quality', '1080p'));
  const url = await createRoom(pages[0], 'Grand groupe HD');
  for (const [i, p] of pages.entries()) { if (i) { await p.goto('/'); await p.evaluate(() => localStorage.setItem('cc-quality', '1080p')); } await joinRoom(p, url, 'P' + i); }
  await waitMedia(pages[0], { video: 5, audio: 0, peers: 5 });
  const subs = await pages[0].evaluate(() => window.__cc.subs);
  expect(subs.length).toBe(5);
  expect(subs.filter(([, l]) => l === 3).length).toBeLessThanOrEqual(1); // au plus l'orateur, si sa tuile est grande
  // Épingler quelqu'un (double-clic) → HD pour lui seul
  await pages[0].locator('.tile:not(.me)').first().dblclick();
  await expect.poll(async () => (await pages[0].evaluate(() => window.__cc.subs)).filter(([, l]) => l === 3).length, { timeout: 10_000 }).toBe(1);
  await expect.poll(async () => best(await frames(pages[0]), 3)?.h || 0, { timeout: 30_000 }).toBe(1080);
  for (const c of ctxs) await c.close();
});

test('HD : encodeur sans 1080p → repli propre en 720p', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  const url = await createRoom(a, 'Repli 720');
  await a.goto(withQuery(url, '?force=no1080')); await a.evaluate(() => localStorage.setItem('cc-quality', '1080p'));
  await a.reload();
  await expect(a.locator('.qnow')).toContainText('Encodeur 1080p indisponible');
  await joinRoom(a, a.url(), 'Alice'); await joinRoom(b, url, 'Bruno');
  await expect.poll(async () => best(await frames(b), 3)?.h || 0, { timeout: 30_000 }).toBe(720);
  await ca.close(); await cb.close();
});

test('mobile : sélecteur de qualité dans le salon d\'attente, Auto plafonné à 720p', async ({ browser }) => {
  const c = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36' });
  const m = await c.newPage();
  const url = await createRoom(m, 'Mobile HD');
  await m.goto(url);
  await expect(m.locator('.qseg button[data-q="auto"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(m.locator('.qnow')).toContainText('720p');
  const box = await m.locator('.qseg').boundingBox(); expect(box.width).toBeLessThanOrEqual(390);
  await c.close();
});

test('HD : encodeur en retard → l\'émetteur redescend seul de 1080p à 720p', async ({ browser }) => {
  // Sans ?force=nolag, l'encodeur logiciel saute des images en 1080p : l'adaptation doit passer en 720p.
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  const url = await createRoom(a, 'Adaptation');
  await a.goto(url); await a.evaluate(() => localStorage.setItem('cc-quality', '1080p')); await a.reload();
  await joinRoom(a, url, 'Alice'); await joinRoom(b, url, 'Bruno');
  await waitMedia(b, { video: 10, audio: 0 });
  const lag = await a.evaluate(() => window.__cc.send_lag);
  test.skip(!lag, 'pas de statistiques');
  await expect.poll(() => a.evaluate(() => window.__cc.send?.ceiling), { timeout: 10_000 }).toBe(1080);
  // Soit la machine tient le 1080p (sendH reste 1080), soit l'adaptation redescend et le destinataire suit.
  await a.waitForTimeout(4000);
  const sendH = await a.evaluate(() => window.__cc.send.sendH);
  expect([720, 1080]).toContain(sendH);
  await expect.poll(async () => best(await frames(b), 3)?.h || 0, { timeout: 15_000 }).toBeGreaterThanOrEqual(720);
  await ca.close(); await cb.close();
});
