// Traitement du micro : mesure du signal réellement produit par la chaîne Web Audio (rendu hors ligne dans la page
// d'appel, donc avec sa CSP), interrupteurs indépendants, application à chaud pendant l'appel, repli sans WebAssembly.
import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, expectAudible, measureMicFx as measure } from './helpers.mjs';

test('mesure du signal : compresseur, dé-esseur et réduction de bruit ont un vrai effet ; coupés = signal intact', async ({ page }) => {
  const url = await createRoom(page, 'Traitement micro ' + Date.now());
  await page.goto(url); await expect(page.locator('#joinBtn')).toBeVisible();
  const OFF = { ns: false, comp: false, deess: false };
  const r = {};
  // tout coupé : sortie = entrée
  r.bypass = await measure(page, OFF, { kind: 'tone', f: 1000, db: -12 });
  expect(Math.abs(r.bypass.outDb - r.bypass.inDb)).toBeLessThan(0.1);
  // compresseur : l'écart entre voix faible et forte se resserre nettement
  const qOff = await measure(page, OFF, { kind: 'tone', f: 1000, db: -40 }), lOff = await measure(page, OFF, { kind: 'tone', f: 1000, db: -6 });
  const q = await measure(page, { ...OFF, comp: true }, { kind: 'tone', f: 1000, db: -40 }), l = await measure(page, { ...OFF, comp: true }, { kind: 'tone', f: 1000, db: -6 });
  r.comp = { ecartAvant: lOff.outDb - qOff.outDb, ecartApres: l.outDb - q.outDb, faible: q.outDb - qOff.outDb, fort: l.outDb - lOff.outDb };
  expect(q.st.comp).toBe('on');
  expect(r.comp.ecartApres).toBeLessThan(r.comp.ecartAvant - 8);
  expect(l.outDb).toBeLessThan(-1); // pas de saturation sur une voix forte
  // dé-esseur : 7 kHz fort atténué, 300 Hz intact
  const s = await measure(page, { ...OFF, deess: true }, { kind: 'tone', f: 7000, db: -10 });
  const v = await measure(page, { ...OFF, deess: true }, { kind: 'tone', f: 300, db: -10 });
  r.deess = { sifflante: s.outDb - s.inDb, voyelle: v.outDb - v.inDb };
  expect(r.deess.sifflante).toBeLessThan(-6);
  expect(Math.abs(r.deess.voyelle)).toBeLessThan(0.5);
  // réduction de bruit (RNNoise wasm) : bruit large bande fortement réduit, voix conservée
  const nz = await measure(page, { ...OFF, ns: true }, { kind: 'noise', db: -30 });
  const vo = await measure(page, { ...OFF, ns: true }, { kind: 'voice', db: -14, noiseDb: -45 });
  r.ns = { bruit: nz.outDb - nz.inDb, voix: vo.outDb - vo.inDb, etat: nz.st.ns };
  console.log('mesures', JSON.stringify(r));
  expect(nz.st.ns).toBe('on');
  expect(r.ns.bruit).toBeLessThan(-10);
  expect(vo.outDb).toBeGreaterThan(-60); // le module tourne (pas un simple silence)
});

test('interrupteurs indépendants : salon d\'attente, appel (à chaud, micro non rouvert), mémorisés', async ({ browser, baseURL }) => {
  const a = await (await browser.newContext({ baseURL })).newPage(), b = await (await browser.newContext({ baseURL })).newPage();
  const url = await createRoom(a, 'Micro réglé ' + Date.now());
  await a.goto(url);
  const sw = k => a.locator(`.tg[data-fx=${k}]`).first();
  for (const k of ['ns', 'comp', 'deess']) await expect(sw(k)).toHaveAttribute('aria-checked', 'false');
  await sw('comp').click();
  await expect(sw('comp')).toHaveAttribute('aria-checked', 'true');
  await expect(sw('ns')).toHaveAttribute('aria-checked', 'false'); await expect(sw('deess')).toHaveAttribute('aria-checked', 'false');
  expect(JSON.parse(await a.evaluate(() => localStorage.getItem('csv-micfx')))).toEqual({ comp: true, deess: false, ns: false });
  await joinRoom(a, url, 'Alice'); await joinRoom(b, url, 'Bruno');
  await expectAudible(b);
  const st = () => a.evaluate(() => ({ ...window.__ccState.audio.chain.status }));
  expect(await st()).toEqual({ ns: 'off', comp: 'on', deess: 'off' });
  const track = await a.evaluate(() => { const t = window.__ccState.stream.getAudioTracks()[0]; window.__track0 = t; return t.readyState; });
  expect(track).toBe('live');
  // pendant l'appel : menu « Plus » → Traitement du micro
  await a.click('#dMore'); await a.getByRole('menuitem', { name: 'Traitement du micro' }).click();
  const dlg = a.getByRole('dialog', { name: 'Traitement du micro' });
  await dlg.locator('.tg[data-fx=ns]').click(); await dlg.locator('.tg[data-fx=deess]').click();
  await expect.poll(st, { timeout: 10_000 }).toEqual({ ns: 'on', comp: 'on', deess: 'on' });
  await a.screenshot({ path: 'test-results/micfx-appel.png' });
  const sent0 = await a.evaluate(() => window.__cc.sent.audio);
  await expectAudible(b);
  expect(await a.evaluate(() => window.__cc.sent.audio)).toBeGreaterThan(sent0);
  expect(await a.evaluate(() => window.__ccState.stream.getAudioTracks()[0] === window.__track0)).toBe(true); // micro non rouvert
  await dlg.locator('.tg[data-fx=comp]').click();
  await expect.poll(st).toEqual({ ns: 'on', comp: 'off', deess: 'on' });
  await expectAudible(b);
  await expect(a.locator('#techInfo')).toHaveCount(0);
  // mémorisé dans le navigateur
  expect(JSON.parse(await a.evaluate(() => localStorage.getItem('csv-micfx')))).toEqual({ comp: false, deess: true, ns: true });
  await a.reload(); await expect(a.locator('.tg[data-fx=ns]').first()).toHaveAttribute('aria-checked', 'true');
  await expect(a.locator('.tg[data-fx=comp]').first()).toHaveAttribute('aria-checked', 'false');
  await a.context().close(); await b.context().close();
});

test('repli sans WebAssembly : réduction de bruit signalée indisponible, compresseur et dé-esseur actifs, son audible', async ({ browser, baseURL }) => {
  const a = await (await browser.newContext({ baseURL })).newPage(), b = await (await browser.newContext({ baseURL })).newPage();
  await a.addInitScript(() => { localStorage.setItem('csv-micfx', JSON.stringify({ ns: true, comp: true, deess: true })); delete window.WebAssembly; });
  const url = await createRoom(b, 'Sans wasm ' + Date.now());
  await joinRoom(b, url, 'Bruno'); await joinRoom(a, url, 'Alice');
  await expect.poll(() => a.evaluate(() => window.__ccState.audio?.chain?.status?.ns), { timeout: 10_000 }).toBe('indisponible');
  expect(await a.evaluate(() => ({ ...window.__ccState.audio.chain.status }))).toEqual({ ns: 'indisponible', comp: 'on', deess: 'on' });
  await expectAudible(b);
  await a.context().close(); await b.context().close();
});

test('repli si le module du dé-esseur ne se charge pas : dé-esseur indisponible, le reste fonctionne, son audible', async ({ browser, baseURL }) => {
  const a = await (await browser.newContext({ baseURL })).newPage(), b = await (await browser.newContext({ baseURL })).newPage();
  // module refusé (ex. moteur sans « import » dans les worklets) : simulé, les requêtes de worklet échappant au routage
  await a.addInitScript(() => {
    localStorage.setItem('csv-micfx', JSON.stringify({ ns: true, comp: true, deess: true }));
    const add = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (u, o) { return /deesser-worklet/.test(u) ? Promise.reject(new DOMException('refusé', 'AbortError')) : add.call(this, u, o); };
  });
  const url = await createRoom(b, 'Sans dé-esseur ' + Date.now());
  await joinRoom(b, url, 'Bruno'); await joinRoom(a, url, 'Alice');
  await expect.poll(() => a.evaluate(() => ({ ...window.__ccState.audio?.chain?.status })), { timeout: 10_000 }).toEqual({ ns: 'on', comp: 'on', deess: 'indisponible' });
  await expectAudible(b);
  await a.context().close(); await b.context().close();
});
