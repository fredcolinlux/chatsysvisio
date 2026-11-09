// WebKit (moteur de Safari / iPhone) et Firefox face à Chrome, dans le même salon, via le seul port HTTP(S).
import { test, expect, chromium } from '@playwright/test';
import fs from 'node:fs';
import { createRoom, joinRoom, waitMedia, withQuery, expectAudible, measureMicFx } from './helpers.mjs';

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

// Traitement du micro dans ce moteur : RNNoise (wasm dans l'AudioWorklet, sous la CSP de la page d'appel), dé-esseur,
// compresseur, puis interrupteurs actifs pendant l'appel avec Chrome en face.
test('traitement du micro : réduction de bruit, dé-esseur et compresseur actifs', async ({ browser, baseURL }) => {
  const OFF = { ns: false, comp: false, deess: false };
  const { w, c, chrome, wctx } = await pair(browser, baseURL);
  const nz = await measureMicFx(w, { ...OFF, ns: true }, { kind: 'noise', db: -30 });
  const s = await measureMicFx(w, { ...OFF, deess: true }, { kind: 'tone', f: 7000, db: -10 });
  const q = await measureMicFx(w, { ...OFF, comp: true }, { kind: 'tone', f: 1000, db: -40 });
  const vo = await measureMicFx(w, { ...OFF, ns: true }, { kind: 'voice', db: -14, noiseDb: -45 });
  console.log(browser.browserType().name(), 'voix avec réduction de bruit', (vo.outDb - vo.inDb).toFixed(1));
  expect(vo.outDb - vo.inDb).toBeGreaterThan(-6); // la voix passe (pas un simple silence)
  console.log(browser.browserType().name(), 'bruit', (nz.outDb - nz.inDb).toFixed(1), 'sifflante', (s.outDb - s.inDb).toFixed(1), 'voix faible', (q.outDb - q.inDb).toFixed(1), JSON.stringify(nz.st));
  expect(nz.st.ns).toBe('on'); expect(nz.outDb - nz.inDb).toBeLessThan(-10);
  expect(s.outDb - s.inDb).toBeLessThan(-6); expect(q.outDb - q.inDb).toBeGreaterThan(4);
  await w.evaluate(() => localStorage.setItem('csv-micfx', JSON.stringify({ ns: true, comp: true, deess: true })));
  await w.evaluate(() => window.__ccState.audio.setFx({ ns: true, comp: true, deess: true }));
  await expect.poll(() => w.evaluate(() => ({ ...window.__ccState.audio.chain.status })), { timeout: 10_000 }).toEqual({ ns: 'on', comp: 'on', deess: 'on' });
  if (micOk(browser)) await expectAudible(c); else await waitMedia(w, { video: 0, audio: 10 });
  await chrome.close(); await wctx.close();
});
