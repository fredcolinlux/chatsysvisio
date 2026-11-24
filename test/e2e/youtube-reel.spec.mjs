// Lecteur YouTube réel (réseau requis) : YT_REEL=1 npx playwright test youtube-reel
// Vérifie que le vrai lecteur youtube-nocookie.com s'affiche sous la CSP de la page d'appel, répond au protocole
// postMessage (prêt, position, état) et suit la personne qui partage chez un spectateur.
import { test, expect } from '@playwright/test';
import { createRoom, joinRoom } from './helpers.mjs';
test.skip(!process.env.YT_REEL, 'réseau YouTube requis (YT_REEL=1)');
// (Chrome par défaut ; WebKit et Firefox : copier ce fichier sous un nom contenant « navigateurs ».)
const VIDEO = process.env.YT_VIDEO || 'aqz-KE-bpKQ'; // Big Buck Bunny (Blender Foundation), intégrable
test('YouTube réel : lecture et synchronisation entre deux pages', async ({ browser }) => {
  const a = await (await browser.newContext()).newPage(), b = await (await browser.newContext()).newPage();
  const csp = []; for (const p of [a, b]) p.on('console', m => { if (/(Content Security Policy|Refused).*(frame|script|youtube|connect)|(frame|script|youtube|connect).*(Content Security Policy|Refused)/i.test(m.text())) csp.push(m.text()); });
  const url = await createRoom(a, 'Réel ' + Date.now(), { isPublic: true });
  await joinRoom(a, url, 'Alice'); await joinRoom(b, url, 'Bruno');
  await expect(b.locator('.tile')).toHaveCount(2);
  await a.click('#dYt'); await a.fill('#ytUrl', `https://www.youtube.com/watch?v=${VIDEO}&t=30s`); await a.click('#ytGo');
  const info = p => p.evaluate(() => { const v = window.__ccState.yt?.view; return v ? { ready: v.player.ready, heard: v.player.heard, ...v.player.info, t: v.player.time(), err: v.error } : null; });
  await expect.poll(async () => (await info(a))?.ready, { timeout: 30000 }).toBe(true);
  await expect.poll(async () => (await info(b))?.ready, { timeout: 30000 }).toBe(true);
  await expect.poll(async () => { const i = await info(b); return i && (i.playerState === 1 ? 'lecture' : JSON.stringify(i)); }, { timeout: 30000 }).toBe('lecture');
  const ta = (await info(a)).t, tb = (await info(b)).t;
  console.log('positions', ta.toFixed(2), tb.toFixed(2), 'muet chez Bruno :', (await info(b)).muted);
  expect(Math.abs(ta - tb)).toBeLessThan(2.5);
  // pause par Alice (commande au lecteur, comme un clic sur pause) → Bruno en pause
  await a.evaluate(() => window.__ccState.yt.view.player.command('pauseVideo'));
  await expect.poll(async () => (await info(b)).playerState, { timeout: 15000 }).toBe(2);
  await a.evaluate(() => { const p = window.__ccState.yt.view.player; p.command('seekTo', [120, true]); p.command('playVideo'); });
  await expect.poll(async () => { const i = await info(b); return i.playerState === 1 && Math.abs(i.t - 120) < 4; }, { timeout: 15000 }).toBe(true);
  expect(csp).toEqual([]);
  if (process.env.YT_SHOTS) await a.waitForTimeout(1500);
});
