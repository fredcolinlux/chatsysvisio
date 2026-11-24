// Captures du lecteur YouTube partagé (YT_SHOTS=1, réseau requis ; YT_STUB=1 pour le bouchon) :
// /workspace/youtube-salon.png (PC, spectateur) et /workspace/youtube-salon-mobile.png (iPhone, spectateur).
import { test, expect } from '@playwright/test';
import { createRoom, joinRoom } from './helpers.mjs';
import { stubYouTube } from './youtube-stub.mjs';
test.skip(!process.env.YT_SHOTS, 'captures à la demande (YT_SHOTS=1)');
const VIDEO = process.env.YT_VIDEO || 'aqz-KE-bpKQ';
const OUT = process.env.YT_OUT || '/workspace';
const iphone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' };
test('captures YouTube', async ({ browser }) => {
  test.setTimeout(120000);
  const ctx = async o => { const c = await browser.newContext(o); if (process.env.YT_STUB) await stubYouTube(c); return c.newPage(); };
  const a = await ctx({ viewport: { width: 1440, height: 900 } });
  const url = await createRoom(a, 'Soirée ciné', {});
  await joinRoom(a, url, 'Bruno');
  const b = await ctx({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await joinRoom(b, url, 'Camille');
  const m = await ctx(iphone);
  await joinRoom(m, url, 'Léa');
  await expect(a.locator('.tile')).toHaveCount(3);
  await a.click('#dYt'); await a.fill('#ytUrl', `https://youtu.be/${VIDEO}?t=95`); await a.click('#ytGo');
  const playing = p => expect.poll(() => p.evaluate(() => window.__ccState.yt?.view?.player.info.playerState), { timeout: 40000 }).toBe(1);
  await playing(b); await playing(m);
  await b.locator('.ytvol').fill('65');
  await b.waitForTimeout(4000); // laisse passer les bandeaux du lecteur
  for (const p of [b, m]) await p.evaluate(() => document.querySelectorAll('.toast').forEach(t => t.remove()));
  await b.mouse.move(5, 450);
  await b.screenshot({ path: `${OUT}/youtube-salon.png` });
  await m.screenshot({ path: `${OUT}/youtube-salon-mobile.png` });
  await a.screenshot({ path: `${OUT}/youtube-salon-partage.png` });
});
