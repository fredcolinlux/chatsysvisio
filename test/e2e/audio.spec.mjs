// Le son de A est-il réellement audible chez B ? Mesure en sortie du lecteur audio (AnalyserNode), dans les deux
// sens, en salon chiffré de bout en bout et en salon public ; repli d'encodeur Opus ; client resté sur une ancienne
// version (rechargement automatique, refus clair d'un ancien protocole).
import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRoom, joinRoom, expectAudible, outputPeak } from './helpers.mjs';

async function duo(browser, baseURL, opts = {}, init) {
  const ctx = async () => { const c = await browser.newContext({ baseURL, ignoreHTTPSErrors: true }); if (init) await c.addInitScript(init); return c; };
  const a = await (await ctx()).newPage(), b = await (await ctx()).newPage();
  const url = await createRoom(a, 'Son ' + Date.now(), opts);
  await joinRoom(a, url, 'Alice'); await joinRoom(b, url, 'Bruno');
  return { a, b, url, close: () => Promise.all([a.context().close(), b.context().close()]) };
}

for (const [label, opts] of [['salon chiffré de bout en bout', {}], ['salon public', { isPublic: true }]]) {
  test(`son audible dans les deux sens (${label}), et coupé quand le micro l'est`, async ({ browser, baseURL }) => {
    const { a, b, close } = await duo(browser, baseURL, opts);
    await expectAudible(b); await expectAudible(a);
    const e2 = await b.evaluate(() => window.__cc.e2ee || null);
    if (!opts.isPublic) { expect(e2.dec).toBeGreaterThan(20); expect(e2.fail + e2.replay).toBe(0); } else expect(e2).toBeNull();
    // Le son entendu chez B vient bien de A : micro de A coupé → silence chez B
    await a.click('#dMic');
    await expect.poll(() => outputPeak(b, 800), { timeout: 10_000 }).toBeLessThan(0.005);
    await a.click('#dMic'); await expectAudible(b);
    // Panneau « Infos techniques » : compteurs visibles
    await b.click('#dMore'); await b.getByRole('menuitem', { name: 'Infos techniques' }).click();
    const panel = b.locator('#techInfo');
    await expect(panel).toContainText('Paquets audio reçus'); await expect(panel).toContainText('Alice');
    await expect(panel).toContainText(opts.isPublic ? 'Paquets audio décodés' : 'Rejetés');
    await close();
  });
}

// Safari / certains Chrome Android : débit constant refusé ; ou accepté par isConfigSupported puis refusé par configure.
const noCbr = mode => `(() => {
  const AE = window.AudioEncoder; if (!AE) return;
  const isCbr = c => c && c.bitrateMode === 'constant';
  const orig = AE.isConfigSupported.bind(AE);
  if (${JSON.stringify(mode)} === 'refusé') AE.isConfigSupported = c => isCbr(c) ? Promise.resolve({ supported: false, config: c }) : orig(c);
  const conf = AE.prototype.configure;
  AE.prototype.configure = function (c) { if (isCbr(c)) { this.__fail = true; return; } return conf.call(this, c); };
  const enc = AE.prototype.encode;
  AE.prototype.encode = function (d) { if (this.__fail) throw new DOMException('closed', 'InvalidStateError'); return enc.call(this, d); };
  const Real = AE;
  window.AudioEncoder = class extends Real {
    constructor(init) { super({ output: init.output, error: init.error }); this.__err = init.error; }
    configure(c) { if (isCbr(c)) { setTimeout(() => this.__err(new DOMException('Unsupported configuration', 'NotSupportedError')), 0); return; } return super.configure(c); }
  };
  window.AudioEncoder.isConfigSupported = AE.isConfigSupported;
})()`;
for (const mode of ['refusé', 'annoncé mais en échec']) {
  test(`encodeur Opus sans débit constant (${mode}) : repli automatique, son audible`, async ({ browser, baseURL }) => {
    const { a, b, close } = await duo(browser, baseURL, {}, noCbr(mode));
    await expectAudible(b); await expectAudible(a);
    expect(await a.evaluate(() => [window.__ccState.audio.codec, window.__cc.opusMode])).toEqual(['opus', 'variable']);
    await close();
  });
}

test('page d\'une ancienne version (cache) : rechargement automatique avant de rejoindre, puis son audible', async ({ browser, baseURL }) => {
  const c = await browser.newContext({ baseURL });
  const a = await c.newPage();
  const url = await createRoom(a, 'Vieille page ' + Date.now());
  await joinRoom(a, url, 'Alice');
  const b = await (await browser.newContext({ baseURL })).newPage();
  let served = 0;
  await b.route('**/r/*', async route => {
    served++;
    if (served > 1) return route.continue();
    // Première visite : la page est servie « depuis un cache », avec le build d'une ancienne version
    const r = await route.fetch(); const body = (await r.text()).replace(/data-build="[^"]*"/, 'data-build="0"');
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body });
  });
  await b.goto(url);
  await expect.poll(() => served, { timeout: 15_000 }).toBe(2);
  await expect(b.locator('#joinBtn')).toBeVisible();
  expect(await b.evaluate(() => document.documentElement.dataset.build)).not.toBe('0');
  expect(b.url()).toBe(url); // la clé (#k=…) est conservée
  await joinRoom(b, b.url(), 'Bruno');
  await expectAudible(b);
  await c.close(); await b.context().close();
});

test('client d\'ancien protocole (1.2 en cache) refusé clairement dans un salon chiffré', async ({ page }) => {
  const url = await createRoom(page, 'Ancien client ' + Date.now());
  await joinRoom(page, url, 'Alice'); await expect(page.locator('.tile')).toHaveCount(1);
  const slug = new URL(url).pathname.split('/').pop();
  const r = await page.evaluate(slug => new Promise(res => {
    const ws = new WebSocket(location.origin.replace('http', 'ws') + '/ws/' + slug); let msg = null;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', name: 'Ancien', caps: {}, state: { mic: true } })); // hello de la 1.2 : sans « proto »
    ws.onmessage = e => { if (typeof e.data === 'string') { const m = JSON.parse(e.data); if (m.t === 'error') msg = m; } };
    ws.onclose = e => res({ code: e.code, msg });
  }), slug);
  expect(r.code).toBe(1008); expect(r.msg.code).toBe('version'); expect(r.msg.message).toMatch(/Ctrl\+F5/);
});

// Mise à jour du serveur pendant un appel (clients restés ouverts) : chaque page recharge la nouvelle version
// d'elle-même, on rejoint, et le son repasse.
test('serveur mis à jour pendant l\'appel : les pages se rechargent seules, puis son audible', async ({ browser }) => {
  test.skip(!!process.env.E2E_BASE, 'serveur local uniquement');
  test.setTimeout(150_000);
  const port = 18794, base = `http://localhost:${port}`, dir = '/tmp/cc-e2e-maj';
  fs.rmSync(dir, { recursive: true, force: true });
  const start = build => new Promise((res, rej) => {
    const srv = spawn('node', ['server/index.mjs'], { env: { ...process.env, PORT: port, HOST: '127.0.0.1', DATA_DIR: dir, APP_BUILD: build, CREATE_PER_10MIN: 50 }, stdio: 'ignore' });
    const t0 = Date.now(), ping = () => fetch(base + '/healthz').then(() => res(srv), () => Date.now() - t0 > 15000 ? rej(new Error('serveur')) : setTimeout(ping, 200));
    ping();
  });
  let srv = await start('100');
  try {
    const { a, b, url } = await duo(browser, base);
    await expectAudible(b);
    srv.kill(); await new Promise(r => srv.once('exit', r));
    srv = await start('101');
    for (const p of [a, b]) {
      await expect.poll(() => p.evaluate(() => document.documentElement.dataset.build).catch(() => ''), { timeout: 60_000 }).toBe('101');
      await expect(p.locator('#joinBtn')).toBeVisible();
    }
    expect(a.url()).toBe(url);
    await joinRoom(a, a.url(), 'Alice'); await joinRoom(b, b.url(), 'Bruno');
    await expectAudible(b); await expectAudible(a);
    await a.context().close(); await b.context().close();
  } finally { srv.kill(); }
});
