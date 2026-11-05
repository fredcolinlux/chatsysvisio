import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, waitMedia } from './helpers.mjs';

test('groupe de 6 : mosaïque, vignettes en basse définition, son des plus actifs', async ({ browser }) => {
  test.setTimeout(150_000);
  const ctxs = [], pages = [];
  for (let i = 0; i < 6; i++) { const c = await browser.newContext(); ctxs.push(c); pages.push(await c.newPage()); }
  const url = await createRoom(pages[0], 'Grande famille');
  for (let i = 0; i < 6; i++) await joinRoom(pages[i], url, 'Invité ' + (i + 1));
  const a = pages[0];
  await expect(a.locator('.tile')).toHaveCount(6, { timeout: 20_000 });
  await waitMedia(a, { video: 3, audio: 3, peers: 5 });
  const st = await a.evaluate(() => ({ subs: window.__cc.subs, need: window.__cc.need }));
  // 6 vignettes visibles (> 4) : abonnement basse définition (couche 0) pour les vignettes ordinaires
  expect(st.subs.length).toBe(5);
  expect(st.subs.filter(([, l]) => l === 0).length).toBeGreaterThanOrEqual(4);
  await expect(a.locator('#roomBadge, .count').first()).toBeVisible();
  for (const c of ctxs) await c.close();
});

test('limite du salon respectée dans l\'interface (salon limité à 2)', async ({ browser }) => {
  const [c1, c2, c3] = [await browser.newContext(), await browser.newContext(), await browser.newContext()];
  const [p1, p2, p3] = [await c1.newPage(), await c2.newPage(), await c3.newPage()];
  await p1.goto('/'); await p1.fill('#roomName', 'Tête-à-tête'); await p1.selectOption('#limit', '2'); await p1.click('#go'); await p1.waitForURL(/\/r\//);
  const url = p1.url();
  await joinRoom(p1, url, 'Un'); await joinRoom(p2, url, 'Deux');
  await expect(p2.locator('.tile')).toHaveCount(2);
  await p3.goto(url);
  await expect(p3.locator('#joinBtn')).toBeDisabled();
  await expect(p3.locator('#joinErr')).toContainText('complet');
  // une place se libère → le bouton se réactive tout seul
  await c2.close();
  await expect(p3.locator('#joinBtn')).toBeEnabled({ timeout: 15_000 });
  await joinRoom(p3, url, 'Trois');
  await expect(p3.locator('.tile')).toHaveCount(2);
  for (const c of [c1, c3]) await c.close();
});
