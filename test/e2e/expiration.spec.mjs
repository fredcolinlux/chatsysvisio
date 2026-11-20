// 1.12 : salon public supprimé quand il reste vide. Serveur dédié avec un délai court (PUBLIC_ROOM_IDLE_TTL_MIN=0.05 = 3 s).
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRoom, joinRoom } from './helpers.mjs';

const PORT = 8796, BASE = `http://localhost:${PORT}`, DIR = '/tmp/cc-e2e-expiration';
let srv;
test.use({ baseURL: BASE });
test.beforeAll(async () => {
  fs.rmSync(DIR, { recursive: true, force: true });
  srv = spawn(process.execPath, ['server/index.mjs'], { env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: DIR, CREATE_PER_10MIN: '200', PUBLIC_URL: '', PUBLIC_ROOM_IDLE_TTL_MIN: '0.05' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/healthz')).ok) return; } catch {} await new Promise(r => setTimeout(r, 200)); }
  throw new Error('serveur de test non démarré');
});
test.afterAll(() => { srv?.kill(); });
const exists = async slug => (await fetch(`${BASE}/api/rooms/${slug}`)).status === 200;

test('salon public : mention dans la salle d\'attente, carte « Vide · supprimé », puis suppression 3 s après le départ', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const url = await createRoom(a, 'Public éphémère ' + Date.now(), { isPublic: true });
  const slug = new URL(url).pathname.split('/').pop();
  await expect(a.locator('#idleTtlHint')).toHaveText(/Ce salon public sera supprimé 3 s après le départ du dernier participant/);
  if (process.env.SHOTS) await a.screenshot({ path: process.env.SHOTS + '/expiration-attente.png' });
  await joinRoom(a, url, 'Alice'); await expect(a.locator('#dock')).toBeVisible();
  await new Promise(r => setTimeout(r, 4000));
  expect(await exists(slug), 'occupé : conservé').toBe(true);
  await a.context().close();
  const b = await (await browser.newContext()).newPage();
  await b.goto('/public');
  const card = b.locator(`a.card[href="/r/${slug}"]`);
  await expect(card).toContainText('Vide · supprimé dans 1 min s\'il reste vide');
  if (process.env.SHOTS) await b.screenshot({ path: process.env.SHOTS + '/expiration-liste.png' });
  await expect.poll(() => exists(slug), { timeout: 10_000 }).toBe(false);
  await b.reload(); await expect(card).toHaveCount(0);
  await b.goto(url); await expect(b.locator('h2')).toHaveText('Salon introuvable');
  await b.context().close();
});

test('salon public : quelqu\'un revient avant le délai → conservé', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const url = await createRoom(a, 'Public retour ' + Date.now(), { isPublic: true });
  const slug = new URL(url).pathname.split('/').pop();
  await joinRoom(a, url, 'Alice'); await expect(a.locator('#dock')).toBeVisible();
  await a.context().close();
  await new Promise(r => setTimeout(r, 1500));
  const b = await (await browser.newContext()).newPage();
  await joinRoom(b, url, 'Bruno'); await expect(b.locator('#dock')).toBeVisible();
  await new Promise(r => setTimeout(r, 4000));
  expect(await exists(slug)).toBe(true);
  await b.context().close();
});

test('salon privé : pas de mention, jamais supprimé par ce mécanisme', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage();
  const url = await createRoom(a, 'Privé durable ' + Date.now());
  const slug = new URL(url).pathname.split('/').pop();
  await expect(a.locator('#joinBtn')).toBeVisible();
  await expect(a.locator('#idleTtlHint')).toHaveCount(0);
  await a.context().close();
  await new Promise(r => setTimeout(r, 4500));
  expect(await exists(slug)).toBe(true);
});
