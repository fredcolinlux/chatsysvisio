// Traitement du micro : mesure du signal réellement produit par la chaîne Web Audio (rendu hors ligne dans la page
// d'appel, donc avec sa CSP), interrupteurs indépendants, application à chaud pendant l'appel, repli sans WebAssembly.
import { test, expect, chromium } from '@playwright/test';
import { createRoom, joinRoom, expectAudible, measureMicFx as measure, measureTune, measureIso } from './helpers.mjs';
import fs from 'node:fs';
import { singer, wav16, parole } from '../../scripts/voix-synthese.mjs';
// micro factice « chanteur » (voix de synthèse un peu fausse, en boucle) pour l'affichage de la note en direct
const VOIX = '/tmp/csv-e2e-voix.wav';
// micro factice « qui parle » pour l'isolateur (le bip du micro factice de Chrome n'est pas une voix : il est retiré)
const PAROLE = '/tmp/csv-e2e-parole.wav';
if (!fs.existsSync(PAROLE)) fs.writeFileSync(PAROLE, wav16(parole(48000, 12, { seed: 3, pauses: false }), 48000));
const fakeMic = file => chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-file-for-fake-audio-capture=' + file] });
if (!fs.existsSync(VOIX)) fs.writeFileSync(VOIX, wav16(singer(48000, [[57, 1.2], [60, 1.2], [64, 1.2]], { cents: [35, -30, 40] }), 48000));

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
  for (const k of ['ns', 'tune', 'comp', 'deess']) await expect(sw(k)).toHaveAttribute('aria-checked', 'false');
  await sw('comp').click();
  await expect(sw('comp')).toHaveAttribute('aria-checked', 'true');
  await expect(sw('ns')).toHaveAttribute('aria-checked', 'false'); await expect(sw('deess')).toHaveAttribute('aria-checked', 'false');
  expect(JSON.parse(await a.evaluate(() => localStorage.getItem('csv-micfx')))).toEqual({ comp: true, deess: false, ns: false, tune: false, tuneSpeed: 50, tuneKey: -1, tuneMinor: false, iso: false, isoLevel: 60 });
  await joinRoom(a, url, 'Alice'); await joinRoom(b, url, 'Bruno');
  await expectAudible(b);
  const st = () => a.evaluate(() => ({ ...window.__ccState.audio.chain.status }));
  expect(await st()).toEqual({ ns: 'off', iso: 'off', tune: 'off', comp: 'on', deess: 'off' });
  const track = await a.evaluate(() => { const t = window.__ccState.stream.getAudioTracks()[0]; window.__track0 = t; return t.readyState; });
  expect(track).toBe('live');
  // pendant l'appel : menu « Plus » → Traitement du micro
  await a.click('#dMore'); await a.getByRole('menuitem', { name: 'Traitement du micro' }).click();
  const dlg = a.getByRole('dialog', { name: 'Traitement du micro' });
  await dlg.locator('.tg[data-fx=ns]').click(); await dlg.locator('.tg[data-fx=deess]').click();
  await expect.poll(st, { timeout: 10_000 }).toEqual({ ns: 'on', iso: 'off', tune: 'off', comp: 'on', deess: 'on' });
  await a.screenshot({ path: 'test-results/micfx-appel.png' });
  const sent0 = await a.evaluate(() => window.__cc.sent.audio);
  await expectAudible(b);
  expect(await a.evaluate(() => window.__cc.sent.audio)).toBeGreaterThan(sent0);
  expect(await a.evaluate(() => window.__ccState.stream.getAudioTracks()[0] === window.__track0)).toBe(true); // micro non rouvert
  await dlg.locator('.tg[data-fx=comp]').click();
  await expect.poll(st).toEqual({ ns: 'on', iso: 'off', tune: 'off', comp: 'off', deess: 'on' });
  await expectAudible(b);
  await expect(a.locator('#techInfo')).toHaveCount(0);
  // mémorisé dans le navigateur
  expect(JSON.parse(await a.evaluate(() => localStorage.getItem('csv-micfx')))).toEqual({ comp: false, deess: true, ns: true, tune: false, tuneSpeed: 50, tuneKey: -1, tuneMinor: false, iso: false, isoLevel: 60 });
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
  expect(await a.evaluate(() => ({ ...window.__ccState.audio.chain.status }))).toEqual({ ns: 'indisponible', iso: 'off', tune: 'off', comp: 'on', deess: 'on' });
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
  await expect.poll(() => a.evaluate(() => ({ ...window.__ccState.audio?.chain?.status })), { timeout: 10_000 }).toEqual({ ns: 'on', iso: 'off', tune: 'off', comp: 'on', deess: 'indisponible' });
  await expectAudible(b);
  await a.context().close(); await b.context().close();
});

// ---- Autotune (1.8) ----
const TUNE_ON = { ns: false, comp: false, deess: false, tune: true, tuneSpeed: 100, tuneKey: -1, tuneMinor: false };
const cents = (f, ref) => 1200 * Math.log2(f / ref);
test('autotune : 450 Hz ressort à 440 Hz (chromatique), Si en Do majeur, latence ≤ 30 ms, bruit intact', async ({ page }) => {
  const url = await createRoom(page, 'Autotune ' + Date.now());
  await page.goto(url); await expect(page.locator('#joinBtn')).toBeVisible();
  const off = await measureTune(page, { ...TUNE_ON, tune: false });
  expect(Math.abs(cents(off.hz, 450))).toBeLessThan(2); expect(off.latencyMs).toBeLessThan(0.5); // coupé : rien ne change
  const a = await measureTune(page, TUNE_ON);
  const b = await measureTune(page, { ...TUNE_ON, tuneKey: 0 }, { f: 470 });
  const nat = await measureTune(page, { ...TUNE_ON, tuneSpeed: 0 });
  const nz = await measureTune(page, TUNE_ON, { kind: 'noise' });
  const all = await measureTune(page, { ...TUNE_ON, comp: true, deess: true });
  console.log('autotune', JSON.stringify({ chromatique: a.hz.toFixed(2), doMajeur470: b.hz.toFixed(2), naturel: nat.hz.toFixed(2), latenceMs: a.latencyMs.toFixed(2), bruitEcart: nz.maxDiff, chaine: all.hz.toFixed(2) }));
  expect(a.st.tune).toBe('on');
  expect(Math.abs(cents(a.hz, 440))).toBeLessThan(3);
  expect(Math.abs(cents(b.hz, 493.88))).toBeLessThan(3);
  expect(Math.abs(cents(nat.hz, 440))).toBeLessThan(3);
  expect(Math.abs(cents(all.hz, 440))).toBeLessThan(3);
  expect(a.latencyMs).toBeGreaterThan(10); expect(a.latencyMs).toBeLessThanOrEqual(30);
  expect(Math.abs(a.latencyMs - a.chainMs)).toBeLessThan(1);
  expect(nz.maxDiff).toBeLessThan(1e-6);
});

test('autotune : interrupteur, réglages masqués tant qu\'il est coupé, à chaud pendant l\'appel, note affichée, mémorisé', async ({ browser, baseURL }) => {
  const chanteur = await chromium.launch({ executablePath: fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--use-file-for-fake-audio-capture=' + VOIX] });
  const a = await (await chanteur.newContext({ baseURL, viewport: { width: 1440, height: 900 }, locale: 'fr-FR' })).newPage(), b = await (await browser.newContext({ baseURL })).newPage();
  const url = await createRoom(a, 'Autotune réglé ' + Date.now());
  await a.goto(url);
  const set = a.locator('.tuneset').first();
  await expect(a.locator('.tg[data-fx=tune]').first()).toHaveAttribute('aria-checked', 'false');
  await expect(set).toBeHidden();
  await a.locator('.tg[data-fx=tune]').first().click();
  await expect(set).toBeVisible();
  await expect(set.locator('.tmode')).toBeHidden(); // chromatique : pas de mode
  await set.locator('.tkey').selectOption('9'); // La
  await expect(set.locator('.tmode')).toBeVisible();
  await set.getByRole('radio', { name: 'Mineur' }).click();
  await set.locator('.tspeed').fill('90');
  await expect(set.locator('.tval')).toHaveText('90 · robot');
  await a.waitForTimeout(400);
  expect(JSON.parse(await a.evaluate(() => localStorage.getItem('csv-micfx')))).toMatchObject({ tune: true, tuneSpeed: 90, tuneKey: 9, tuneMinor: true, ns: false, comp: false, deess: false });
  await joinRoom(a, url, 'Alice'); await joinRoom(b, url, 'Bruno');
  await expectAudible(b);
  const st = () => a.evaluate(() => ({ ...window.__ccState.audio.chain.status }));
  await expect.poll(st, { timeout: 10_000 }).toEqual({ ns: 'off', iso: 'off', tune: 'on', comp: 'off', deess: 'off' });
  await a.click('#dMore'); await a.getByRole('menuitem', { name: 'Traitement du micro' }).click();
  const dlg = a.getByRole('dialog', { name: 'Traitement du micro' });
  await expect(dlg.locator('.tunenow')).toHaveText(/Hz · correction|Pas de voix/, { timeout: 10_000 });
  await expect(dlg.locator('.tunenow.tn-live')).toHaveText(/(Do|Ré|Mi|Fa|Sol|La|Si)[♯♭]? \d.* Hz · correction [−+±]\d+ cents/, { timeout: 15_000 });
  await a.screenshot({ path: 'test-results/autotune-appel.png' });
  // à chaud : coupé puis rallumé, micro non rouvert, son toujours audible
  const t0 = await a.evaluate(() => { window.__t0 = window.__ccState.stream.getAudioTracks()[0]; return 1; });
  await dlg.locator('.tg[data-fx=tune]').click(); await expect(dlg.locator('.tuneset')).toBeHidden();
  await expect.poll(st).toEqual({ ns: 'off', iso: 'off', tune: 'off', comp: 'off', deess: 'off' });
  await dlg.locator('.tg[data-fx=tune]').click(); await expect(dlg.locator('.tuneset')).toBeVisible();
  await expect.poll(st).toEqual({ ns: 'off', iso: 'off', tune: 'on', comp: 'off', deess: 'off' });
  await expectAudible(b);
  expect(await a.evaluate(() => window.__ccState.stream.getAudioTracks()[0] === window.__t0)).toBe(true);
  // réglage transmis au module audio (vitesse 0 = naturel)
  await dlg.locator('.tuneset .tspeed').fill('0');
  await expect(dlg.locator('.tuneset .tval')).toHaveText('0 · naturelle');
  await a.reload(); await a.locator('.tg[data-fx=tune]').first().waitFor();
  await expect(a.locator('.tg[data-fx=tune]').first()).toHaveAttribute('aria-checked', 'true');
  await expect(a.locator('.tuneset .tkey').first()).toHaveValue('9');
  await expect(a.locator('.tuneset .tspeed').first()).toHaveValue('0');
  await chanteur.close(); await b.context().close();
});

test('autotune : repli si le module ne se charge pas (ou sans AudioWorklet) → signalé indisponible, son audible', async ({ browser, baseURL }) => {
  const a = await (await browser.newContext({ baseURL })).newPage(), b = await (await browser.newContext({ baseURL })).newPage();
  await a.addInitScript(() => {
    localStorage.setItem('csv-micfx', JSON.stringify({ tune: true, comp: true }));
    const add = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (u, o) { return /autotune-worklet/.test(u) ? Promise.reject(new DOMException('refusé', 'AbortError')) : add.call(this, u, o); };
  });
  const url = await createRoom(b, 'Sans autotune ' + Date.now());
  await joinRoom(b, url, 'Bruno'); await joinRoom(a, url, 'Alice');
  await expect.poll(() => a.evaluate(() => ({ ...window.__ccState.audio?.chain?.status })), { timeout: 10_000 }).toEqual({ ns: 'off', iso: 'off', tune: 'indisponible', comp: 'on', deess: 'off' });
  await expectAudible(b);
  await a.click('#dMore'); await a.getByRole('menuitem', { name: 'Traitement du micro' }).click();
  await expect(a.getByRole('dialog').locator('.tunenow')).toHaveText(/indisponible/);
  await a.context().close(); await b.context().close();
});

// ---- Isolateur de voix (1.9) ----
const ISO_ON = { ns: false, comp: false, deess: false, tune: false, iso: true, isoLevel: 60 };
test('isolateur : musique −25 dB pendant tes pauses, ta voix intacte, latence 39,3 ms ; avec la réduction de bruit, un seul traitement', async ({ page }) => {
  const url = await createRoom(page, 'Isolateur ' + Date.now());
  await page.goto(url); await expect(page.locator('#joinBtn')).toBeVisible();
  const off = await measureIso(page, { ...ISO_ON, iso: false });
  const a = await measureIso(page, ISO_ON);
  const both = await measureIso(page, { ...ISO_ON, ns: true });
  const far = await measureIso(page, ISO_ON, { other: 'lointaine', relDb: -14 });
  const chain = await measureIso(page, { ns: true, iso: true, isoLevel: 60, tune: true, tuneSpeed: 50, tuneKey: -1, tuneMinor: false, comp: true, deess: true });
  console.log('isolateur', JSON.stringify({ musiquePauses: a.pausesDb.toFixed(1), voix: a.voiceDb.toFixed(2), latenceMs: a.latencyMs.toFixed(2), prevueMs: a.isoMs.toFixed(2), coupe: off.pausesDb.toFixed(2), avecRNNoise: both.pausesDb.toFixed(1), lointaine: far.pausesDb.toFixed(1), demarrageMs: a.startMs, chargementMs: Math.round(a.loadMs), toutLatenceMs: chain.latencyMs.toFixed(1) }));
  expect(off.st.iso).toBe('off'); expect(Math.abs(off.pausesDb)).toBeLessThan(0.1); expect(off.latencyMs).toBeLessThan(0.1);
  expect(a.st).toEqual({ ns: 'off', iso: 'on', tune: 'off', comp: 'off', deess: 'off' });
  expect(a.pausesDb).toBeLessThan(-25);
  expect(Math.abs(a.voiceDb)).toBeLessThan(1);
  expect(Math.abs(a.latencyMs - a.isoMs)).toBeLessThan(0.1); expect(a.latencyMs).toBeLessThanOrEqual(40);
  // réduction de bruit + isolateur : RNNoise en pause (« inclus »), même latence que l'isolateur seul
  expect(both.st).toEqual({ ns: 'inclus', iso: 'on', tune: 'off', comp: 'off', deess: 'off' });
  expect(Math.abs(both.latencyMs - a.latencyMs)).toBeLessThan(0.1);
  expect(far.pausesDb).toBeLessThan(-8);
  expect(chain.st).toEqual({ ns: 'inclus', iso: 'on', tune: 'on', comp: 'on', deess: 'on' });
});

test('isolateur : interrupteur, indicateur de chargement, intensité mémorisée, à chaud pendant l\'appel, réduction de bruit « incluse »', async ({ browser, baseURL }) => {
  const parleur = await fakeMic(PAROLE);
  const a = await (await parleur.newContext({ baseURL, viewport: { width: 1440, height: 900 }, locale: 'fr-FR' })).newPage(), b = await (await browser.newContext({ baseURL })).newPage();
  // modèle servi lentement pour voir l'indicateur de téléchargement
  await a.route('**/vendor/deepfilter/df_bg.wasm', async r => { await new Promise(res => setTimeout(res, 2500)); await r.continue(); });
  const url = await createRoom(a, 'Isolateur réglé ' + Date.now());
  await a.goto(url);
  const tg = a.locator('.tg[data-fx=iso]').first(), set = a.locator('.isoset').first();
  await expect(tg).toHaveAttribute('aria-checked', 'false'); await expect(set).toBeHidden();
  await a.locator('.tg[data-fx=ns]').first().click();
  await tg.click(); await expect(set).toBeVisible();
  await expect(set.locator('.isonow')).toHaveText(/quand tu rejoins/);
  await set.locator('.ilevel').fill('80'); await expect(set.locator('.tval')).toHaveText('80 · forte');
  expect(JSON.parse(await a.evaluate(() => localStorage.getItem('csv-micfx')))).toMatchObject({ iso: true, isoLevel: 80, ns: true });
  await joinRoom(a, url, 'Alice'); await joinRoom(b, url, 'Bruno');
  await a.click('#dMore'); await a.getByRole('menuitem', { name: 'Traitement du micro' }).click();
  const dlg = a.getByRole('dialog', { name: 'Traitement du micro' });
  await expect(dlg.locator('.isonow')).toHaveText(/Téléchargement du modèle… \d+ %|Préparation du modèle|Démarrage du modèle/, { timeout: 10_000 });
  await expect(dlg.locator('.isobar')).toBeVisible();
  await a.screenshot({ path: 'test-results/isolateur-chargement.png' });
  const st = () => a.evaluate(() => ({ ...window.__ccState.audio.chain.status }));
  await expect.poll(st, { timeout: 30_000 }).toEqual({ ns: 'inclus', iso: 'on', tune: 'off', comp: 'off', deess: 'off' });
  await expect(dlg.locator('.isonow.iso-live')).toHaveText(/Actif · 39 ms de latence.*réduction de bruit incluse/);
  await expect(dlg.locator('.isobar')).toBeHidden();
  await expect(dlg.locator('.fxnow')).toContainText('incluse dans l\'isolateur');
  await expectAudible(b);
  // à chaud : coupé → RNNoise reprend, rallumé → modèle déjà chargé (instantané), micro non rouvert
  await a.evaluate(() => { window.__t0 = window.__ccState.stream.getAudioTracks()[0]; });
  await dlg.locator('.tg[data-fx=iso]').click(); await expect(dlg.locator('.isoset')).toBeHidden();
  await expect.poll(st).toEqual({ ns: 'on', iso: 'off', tune: 'off', comp: 'off', deess: 'off' });
  await dlg.locator('.tg[data-fx=iso]').click();
  await expect.poll(st, { timeout: 2000 }).toEqual({ ns: 'inclus', iso: 'on', tune: 'off', comp: 'off', deess: 'off' });
  await expectAudible(b);
  expect(await a.evaluate(() => window.__ccState.stream.getAudioTracks()[0] === window.__t0)).toBe(true);
  await dlg.locator('.ilevel').fill('30'); await expect(dlg.locator('.isoset .tval')).toHaveText('30 · douce');
  await a.reload(); await a.locator('.tg[data-fx=iso]').first().waitFor();
  await expect(a.locator('.tg[data-fx=iso]').first()).toHaveAttribute('aria-checked', 'true');
  await expect(a.locator('.isoset .ilevel').first()).toHaveValue('30');
  await parleur.close(); await b.context().close();
});

test('isolateur : repli si le modèle ne se télécharge pas → « indisponible », la réduction de bruit reprend, son audible', async ({ browser, baseURL }) => {
  const a = await (await browser.newContext({ baseURL })).newPage(), b = await (await browser.newContext({ baseURL })).newPage();
  await a.route('**/vendor/deepfilter/df_bg.wasm', r => r.abort());
  await a.addInitScript(() => localStorage.setItem('csv-micfx', JSON.stringify({ iso: true, ns: true })));
  const url = await createRoom(b, 'Sans isolateur ' + Date.now());
  await joinRoom(b, url, 'Bruno'); await joinRoom(a, url, 'Alice');
  await expect.poll(() => a.evaluate(() => ({ ...window.__ccState.audio?.chain?.status })), { timeout: 15_000 }).toEqual({ ns: 'on', iso: 'indisponible', tune: 'off', comp: 'off', deess: 'off' });
  await expectAudible(b);
  await a.click('#dMore'); await a.getByRole('menuitem', { name: 'Traitement du micro' }).click();
  await expect(a.getByRole('dialog').locator('.isonow')).toHaveText(/Isolateur indisponible : .+ Le son passe sans isolation\./);
  await a.context().close(); await b.context().close();
});
