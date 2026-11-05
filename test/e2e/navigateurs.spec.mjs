// WebKit (moteur de Safari / iPhone) et Firefox face à Chrome, dans le même salon, via le seul port HTTP(S).
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import { createRoom, joinRoom, waitMedia, withQuery, expectAudible } from './helpers.mjs';

const chromeOpts = {
  executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
};

// Firefox sans interface n'a pas de périphérique de sortie audio sur ce banc de test : son AudioContext reste
// suspendu, donc il reçoit/décode le son mais n'en capture pas. On ne vérifie alors que le sens Chrome → Firefox.
const micOk = browser => browser.browserType().name() !== 'firefox';

async function pair(browser, baseURL, query = '', opts = {}) {
  const wctx = browser.browserType().name() === 'webkit' ? await browser.newContext({ permissions: ['camera', 'microphone'] }) : await browser.newContext();
  const w = await wctx.newPage();
  const chrome = await chromium.launch(chromeOpts);
  const c = await (await chrome.newContext({ baseURL, ignoreHTTPSErrors: true })).newPage();
  const url = await createRoom(c, 'Safari et Chrome ' + Date.now(), opts);
  await joinRoom(c, url, 'Chloé (Chrome)');
  await w.goto(withQuery(url, query));
  await joinRoom(w, w.url(), 'Sacha (Safari)');
  return { w, c, chrome, wctx };
}

// Son réellement audible (sortie du lecteur), en salon chiffré de bout en bout et en salon public.
for (const [label, opts] of [['chiffré de bout en bout', {}], ['public', { isPublic: true }]]) {
  test(`↔ Chrome : son audible (salon ${label})`, async ({ browser, baseURL }) => {
    const { w, c, chrome, wctx } = await pair(browser, baseURL, '', opts);
    if (micOk(browser)) { await expectAudible(c); await expectAudible(w); }
    else await waitMedia(w, { video: 0, audio: 10 }); // Firefox sans sortie audio ici : son reçu et décodé
    if (!opts.isPublic) expect(await w.evaluate(() => window.__cc.e2ee.fail)).toBe(0);
    await chrome.close(); await wctx.close();
  });
}

test('↔ Chrome : vidéo et son dans les deux sens (WebCodecs)', async ({ browser, baseURL }) => {
  const { w, c, chrome, wctx } = await pair(browser, baseURL);
  await waitMedia(w, { video: 5 }); await waitMedia(c, { video: 5, audio: micOk(browser) ? 10 : 0 });
  const s = await w.evaluate(() => ({ caps: window.__cc.caps, codecs: window.__cc.codecs }));
  console.log(browser.browserType().name(), JSON.stringify(s));
  expect(['vp8', 'avc']).toContain(s.codecs.video);
  await expect(w.locator('.tile')).toHaveCount(2);
  // chat croisé
  for (const p of [c, w]) if (!(await p.locator('#chatIn').isVisible())) await p.click('#dChat');
  await w.fill('#chatIn', 'Bonjour depuis **l\'autre navigateur**'); await w.press('#chatIn', 'Enter');
  await expect(c.locator('.msg strong', { hasText: 'autre navigateur' })).toBeVisible();
  await chrome.close(); await wctx.close();
});

test('sans WebCodecs (ex. iPhone iOS < 26) : repli JPEG + ADPCM', async ({ browser, baseURL }) => {
  const { w, c, chrome, wctx } = await pair(browser, baseURL, '?force=jpeg,adpcm');
  await waitMedia(w, { video: 5 }); await waitMedia(c, { video: 5, audio: micOk(browser) ? 10 : 0 });
  expect(await c.evaluate(() => window.__cc.codecs)).toEqual({ video: 'jpeg', audio: 'adpcm' });
  await chrome.close(); await wctx.close();
});
