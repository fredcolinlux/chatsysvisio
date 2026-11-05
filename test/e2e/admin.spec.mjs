import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { totp } from '../../server/totp.mjs';
import { createRoom, joinRoom } from './helpers.mjs';

// Compte admin créé avec la CLI (comme sur le serveur), code TOTP calculé ici comme le ferait l'application du téléphone.
const PW = 'phrase-admin-e2e-solide';
let admin;
test.beforeAll(() => {
  const out = execFileSync('node', ['scripts/chatsysvisio-admin.mjs', 'create-admin', '--user', 'admin', '--data-dir', '/tmp/cc-e2e', '--password-stdin', '--no-verify', '--json', '--force'], { input: PW + '\n' });
  admin = JSON.parse(out.toString());
  expect(admin.ok).toBe(true);
});
test.describe.configure({ mode: 'serial' });

async function waitFreshStep() { // un code TOTP ne sert qu'une fois : on attend le pas suivant si besoin
  const left = 30 - (Math.floor(Date.now() / 1000) % 30); if (left < 30) await new Promise(r => setTimeout(r, left * 1000 + 300));
}
async function login(page, code) {
  await page.goto('/admin/');
  await expect(page.locator('#loginForm')).toBeVisible();
  await page.fill('#user', 'admin'); await page.fill('#password', PW); await page.fill('#code', code);
  await page.click('#loginForm button[type=submit]');
}

test('page d\'administration introuvable depuis l\'extérieur du réseau local', async ({ browser }) => {
  const ctx = await browser.newContext({ extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.50', 'X-Forwarded-Proto': 'https' } });
  const p = await ctx.newPage();
  const r = await p.goto('/admin/');
  expect(r.status()).toBe(404);
  await expect(p.locator('body')).not.toContainText('Administration');
  expect((await p.request.get('/admin/api/me')).status()).toBe(404);
  await ctx.close();
});

test('connexion admin avec TOTP, mauvais code refusé, réglages et exclusion', async ({ browser, page }) => {
  await login(page, '000000');
  await expect(page.locator('#loginErr')).toContainText('incorrect');
  await waitFreshStep();
  await login(page, totp(admin.secret));
  await expect(page.locator('#shell')).toBeVisible();
  await expect(page.locator('#title')).toHaveText('Vue d\'ensemble');
  await expect(page.locator('.kpi').first()).toBeVisible();
  await expect(page.locator('.chart svg').first()).toBeVisible();
  // réglages à chaud
  await page.click('#nav a[href="#settings"]');
  await page.fill('#set-maxParticipants', '12'); await page.locator('#set-maxParticipants').dispatchEvent('change');
  await page.selectOption('#set-signupMode', 'approval');
  await page.click('#saveSettings');
  await expect(page.locator('.toast')).toContainText(/enregistr/i);
  // un salon, deux personnes, exclusion avec bannissement
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  const url = await createRoom(a, 'Salon surveillé');
  await joinRoom(a, url, 'Alice'); await joinRoom(b, url, 'Gêneur');
  await expect(b.locator('.tile')).toHaveCount(2, { timeout: 20_000 });
  await page.click('#nav a[href="#rooms"]');
  const row = page.locator('tr', { hasText: 'Gêneur' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('127.0.0.••');
  await expect(page.locator('.badge', { hasText: 'bout en bout' }).first()).toBeVisible(); // métadonnées seulement
  await row.getByRole('button', { name: 'Exclure' }).click();
  await page.selectOption('#banMin', '10');
  await page.click('#confirmOk');
  await expect(b.locator('body')).toContainText('L\'administrateur t\'a retiré de ce salon', { timeout: 10_000 });
  await b.goto(url.split('#')[0]); await b.fill('#name', 'Gêneur'); await b.click('#joinBtn'); // clé retrouvée dans ce navigateur
  await expect(b.locator('body')).toContainText(/banni|exclu/i);
  // journal
  await page.click('#nav a[href="#events"]');
  await expect(page.locator('#evTable')).toContainText('banni 10 min');
  await page.fill('#evq', 'Gêneur'); await page.locator('#evq').press('Enter');
  await expect(page.locator('#evTable tbody tr').first()).toContainText('Gêneur');
  await ca.close(); await cb.close();
});

test('inscription (mode validation), validation par l\'admin, pseudo réservé', async ({ browser, page }) => {
  const cu = await browser.newContext(); const u = await cu.newPage();
  await u.goto('/compte');
  await u.click('#tabSignup');
  await u.fill('#sname', 'Claire'); await u.fill('#spw', 'mot-de-passe-claire'); await u.fill('#spw2', 'mot-de-passe-claire');
  await u.click('#signupForm button[type=submit]');
  await expect(u.locator('#acct')).toContainText('attend la validation');

  await waitFreshStep();
  await login(page, totp(admin.secret));
  await page.click('#nav a[href="#accounts"]');
  const row = page.locator('#accTable tr[data-name="Claire"]');
  await expect(row).toContainText('en attente');
  await row.getByRole('button', { name: 'Valider' }).click();
  await expect(row).toContainText('actif');

  await u.goto('/compte');
  await u.fill('#lname', 'claire'); await u.fill('#lpw', 'mot-de-passe-claire');
  await u.click('#loginForm button[type=submit]');
  await expect(u.locator('#acct')).toContainText('Claire');
  await expect(u.locator('#accLink')).toContainText('Claire');

  // un invité ne peut pas prendre le pseudo du compte
  const cg = await browser.newContext(); const g = await cg.newPage();
  const url = await createRoom(u, 'Salon de Claire');
  await g.goto(url); await g.fill('#name', 'CLAIRE'); await g.click('#joinBtn');
  await expect(g.locator('body')).toContainText(/réservé/i);
  // le compte rejoint avec son pseudo imposé
  await u.goto(url); await expect(u.locator('#name')).toHaveValue('Claire');
  await cu.close(); await cg.close();
  // remise des réglages par défaut pour les autres scénarios
  await page.click('#nav a[href="#settings"]');
  await page.fill('#set-maxParticipants', '25'); await page.locator('#set-maxParticipants').dispatchEvent('change');
  await page.selectOption('#set-signupMode', 'closed');
  await page.click('#saveSettings');
  await expect(page.locator('.toast').last()).toContainText(/enregistr/i);
});
