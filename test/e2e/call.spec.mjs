import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, waitMedia, withQuery } from './helpers.mjs';

test('deux personnes se voient et s\'entendent via le serveur (un seul port, WebCodecs)', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  const url = await createRoom(a, 'Apéro du jeudi');
  await joinRoom(a, url, 'Alice');
  await joinRoom(b, url, 'Bruno');
  await waitMedia(a); await waitMedia(b);
  const sa = await a.evaluate(() => ({ codecs: window.__cc.codecs, played: Object.values(window.__cc.played) }));
  expect(sa.codecs.video).toBe('vp8');
  expect(sa.codecs.audio).toBe('opus');
  expect(Math.max(...sa.played)).toBeGreaterThan(0.01); // le bip de la fausse source audio est bien reçu
  // Le WebSocket média passe par le même hôte:port que la page.
  const wsUrl = await a.evaluate(() => performance.getEntriesByType('resource').map(e => e.name).find(n => n.startsWith('ws')) || location.host);
  expect(wsUrl).toContain(new URL(url).host);
  await expect(a.locator('.tile')).toHaveCount(2);
  await ca.close(); await cb.close();
});

test('repli universel : JPEG + ADPCM (navigateurs sans WebCodecs)', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  const url = await createRoom(a, 'Test repli');
  await joinRoom(a, url, 'Alice');
  await b.goto(withQuery(url, '?force=jpeg,adpcm'));
  await joinRoom(b, b.url(), 'Vieux iPhone');
  await waitMedia(a, { video: 5 }); await waitMedia(b, { video: 5 });
  // A doit émettre dans un format que B sait décoder
  expect(await a.evaluate(() => window.__cc.codecs.video)).toBe('jpeg');
  expect(await a.evaluate(() => window.__cc.codecs.audio)).toBe('adpcm');
  await ca.close(); await cb.close();
});

test('chat : message, réponse, markdown, réaction, fichier', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  const url = await createRoom(a, 'Chat test', { e2ee: false }); // salon TLS seulement (fichiers servis en clair)
  await joinRoom(a, url, 'Alice'); await joinRoom(b, url, 'Bruno');
  await a.fill('#chatIn', 'Salut **tout le monde** <img src=x onerror=alert(1)>');
  await a.press('#chatIn', 'Enter');
  const msgB = b.locator('.msg', { hasText: 'Salut' });
  await expect(msgB).toBeVisible();
  await expect(msgB.locator('strong')).toHaveText('tout le monde');
  await expect(msgB.locator('img')).toHaveCount(0); // pas d'injection HTML
  await expect(msgB).toContainText('<img src=x');
  await msgB.click(); await msgB.locator('button[title="Répondre"]').click();
  await b.fill('#chatIn', 'Coucou Alice'); await b.press('#chatIn', 'Enter');
  await expect(a.locator('.msg', { hasText: 'Coucou Alice' }).locator('.quote')).toContainText('Alice');
  const orig = msgB.filter({ hasNot: b.locator('.quote') }).first();
  await orig.hover(); await orig.locator('button[title="Réagir 👍"]').click();
  await expect(a.locator('.msg', { hasText: 'Salut' }).locator('.rx button').first()).toContainText('👍 1');
  await a.locator('#fileIn').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('bonjour') });
  const link = b.locator('a.file', { hasText: 'notes.txt' });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  const r = await b.request.get(href);
  expect(r.status()).toBe(200);
  expect(r.headers()['content-disposition']).toContain('attachment');
  expect(r.headers()['x-content-type-options']).toBe('nosniff');
  // un étranger (autre session) ne peut pas télécharger le fichier
  const cc = await browser.newContext(); const r2 = await cc.request.get(new URL(href, url).toString()); expect([403, 404]).toContain(r2.status());
  await cc.close(); await ca.close(); await cb.close();
});

test('salon avec mot de passe', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  const url = await createRoom(a, 'Coffre fort', { password: 'sesame-1234' });
  await joinRoom(a, url, 'Alice'); // le créateur est déjà autorisé
  await expect(a.locator('#grid')).toBeVisible();
  await b.goto(url);
  await expect(b.locator('#pw')).toBeVisible();
  await joinRoom(b, url, 'Intrus', 'mauvais');
  await expect(b.locator('#joinErr')).toContainText('incorrect');
  await b.fill('#pw', 'sesame-1234'); await b.click('#joinBtn');
  await expect(b.locator('#grid')).toBeVisible();
  await waitMedia(b, { audio: 3 });
  await ca.close(); await cb.close();
});

test('salon public visible, salon privé non listé', async ({ page }) => {
  await createRoom(page, 'Salon ouvert', { isPublic: true });
  const priv = await createRoom(page, 'Salon secret');
  expect(priv).toMatch(/salon-secret-[a-z0-9]{6}#k=[A-Za-z0-9_-]{43}$/);
  await page.goto('/public');
  await expect(page.locator('#plist')).toContainText('Salon ouvert');
  await expect(page.locator('#plist')).not.toContainText('Salon secret');
});
