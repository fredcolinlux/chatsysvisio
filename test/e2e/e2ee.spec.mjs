import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRoom, joinRoom, waitMedia } from './helpers.mjs';

const DATA = '/tmp/cc-e2e';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

// Enregistre ce que le serveur envoie au navigateur (= ce que le relais voit passer)
function spy(page) {
  const seen = { text: [], bin: [] };
  page.on('websocket', ws => ws.on('framereceived', f => { if (typeof f.payload === 'string') seen.text.push(f.payload); else seen.bin.push(Buffer.from(f.payload)); }));
  return seen;
}
const decoded = (p, kind) => p.evaluate(k => Object.values(window.__cc.decoded[k]).reduce((a, b) => a + b, 0), kind);
// Stockage d'un salon (repéré par son slug) : historique JSONL + fichiers (données et méta)
const readStore = url => {
  const slug = new URL(url).pathname.split('/')[2];
  const room = JSON.parse(fs.readFileSync(path.join(DATA, 'rooms.json'), 'utf8')).find(r => r.slug === slug);
  const mf = path.join(DATA, 'messages', room.id + '.jsonl');
  const msgs = fs.existsSync(mf) ? fs.readFileSync(mf, 'utf8') : '';
  const metas = fs.readdirSync(path.join(DATA, 'files')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(DATA, 'files', f), 'utf8'))).filter(m => m.roomId === room.id);
  const files = metas.map(m => ({ meta: m, data: fs.readFileSync(path.join(DATA, 'files', m.id)) }));
  return { room, msgs, files };
};

test('E2EE : 3 personnes se voient, s\'entendent et discutent ; le relais et le stockage ne voient que du chiffré', async ({ browser }) => {
  test.setTimeout(150_000);
  const ctx = [await browser.newContext(), await browser.newContext(), await browser.newContext()];
  const [a, b, c] = await Promise.all(ctx.map(x => x.newPage()));
  const seenB = spy(b);
  const url = await createRoom(a, 'Conseil secret');
  expect(url).toMatch(/#k=[A-Za-z0-9_-]{43}$/);
  await joinRoom(a, url, 'Alice'); await joinRoom(b, url, 'Bruno'); await joinRoom(c, url, 'Chloé');
  for (const p of [a, b, c]) await waitMedia(p, { peers: 2 });
  expect(await a.evaluate(() => window.__cc.codecs)).toEqual({ video: 'vp8', audio: 'opus' });
  expect(Math.max(...await b.evaluate(() => Object.values(window.__cc.played)))).toBeGreaterThan(0.01);
  // Indicateur et code de sécurité identiques chez tous
  await expect(a.locator('#e2eeBadge')).toContainText('Chiffré de bout en bout');
  const codes = [];
  for (const p of [a, b, c]) { await p.click('#e2eeBadge'); const t = await p.locator('#safetyCode').textContent(); codes.push(t); expect(t).toMatch(/^\d{4} \d{4} \d{4}$/); await p.keyboard.press('Escape'); }
  expect(new Set(codes).size).toBe(1);

  // Chat, réponse, réaction, fichiers
  await a.fill('#chatIn', 'Message ultra secret 42 **gras**'); await a.press('#chatIn', 'Enter');
  for (const p of [b, c]) await expect(p.locator('.msg', { hasText: 'Message ultra secret 42' }).locator('strong')).toHaveText('gras');
  const mb = b.locator('.msg', { hasText: 'ultra secret' }).first();
  await mb.click(); await mb.locator('button[title="Répondre"]').click();
  await b.fill('#chatIn', 'Réponse confidentielle'); await b.press('#chatIn', 'Enter');
  await expect(a.locator('.msg', { hasText: 'Réponse confidentielle' }).locator('.quote')).toContainText('Message ultra secret');
  await mb.hover(); await mb.locator('button[title="Réagir 👍"]').click();
  await expect(a.locator('.msg', { hasText: 'Message ultra secret' }).first().locator('.rx button').first()).toContainText('👍 1');
  await expect(b.locator('.msg', { hasText: 'Message ultra secret' }).first().locator('.rx button.me')).toHaveCount(1);
  await a.locator('#fileIn').setInputFiles([{ name: 'photo-vacances.png', mimeType: 'image/png', buffer: PNG }, { name: 'rapport-secret.txt', mimeType: 'text/plain', buffer: Buffer.from('contenu confidentiel du rapport') }]);
  const img = b.locator('.msg img.imgmsg');
  await expect(img).toHaveAttribute('src', /^blob:/, { timeout: 15_000 });
  const fileLink = b.locator('a.file', { hasText: 'rapport-secret.txt' });
  await expect(fileLink).toBeVisible();
  const [dl] = await Promise.all([b.waitForEvent('download'), fileLink.click()]);
  expect(dl.suggestedFilename()).toBe('rapport-secret.txt');
  expect(fs.readFileSync(await dl.path(), 'utf8')).toBe('contenu confidentiel du rapport');

  // Ce que le relais a transmis : aucun texte lisible, trames média chiffrées (en-tête clair, charge opaque)
  const allText = seenB.text.join('\n');
  for (const s of ['ultra secret', 'confidentiel', 'rapport-secret', 'photo-vacances', '👍']) expect(allText).not.toContain(s);
  const media = seenB.bin.filter(x => x[0] === 1 || x[0] === 2);
  expect(media.length).toBeGreaterThan(50);
  const vp8Key = media.filter(x => x[0] === 1 && x.length > 20 && x[12 + 3] === 0x9d && x[12 + 4] === 0x01 && x[12 + 5] === 0x2a);
  expect(vp8Key.length).toBe(0); // aucune image clé VP8 en clair (code de départ 9d 01 2a)
  expect(media.every(x => x.length >= 12 + 23)).toBe(true);
  // Stockage : historique et fichiers opaques
  const st = readStore(url);
  for (const s of ['ultra secret', 'confidentiel', 'rapport-secret', 'photo-vacances']) expect(st.msgs).not.toContain(s);
  expect(st.msgs).toContain('"enc"');
  expect(st.files.length).toBeGreaterThanOrEqual(2);
  for (const { meta, data } of st.files) {
    expect(data.subarray(0, 4).toString()).toBe('CCE1');
    expect(data.includes(Buffer.from('confidentiel'))).toBe(false); expect(data.includes(Buffer.from('PNG'))).toBe(false);
    expect(meta.name).toBe('fichier-chiffre.bin'); expect(meta.type).toBe('application/octet-stream');
  }
  expect(JSON.stringify(st.room)).not.toContain('ultra');
  // Départ de Chloé : rotation de la clé média, Alice et Bruno continuent de se voir et s'entendre
  const before = await a.evaluate(() => window.__ccState.e2.session.media.cur);
  await ctx[2].close();
  await expect.poll(() => a.evaluate(() => window.__ccState.e2.session.media.cur), { timeout: 10_000 }).not.toBe(before);
  const cur = await a.evaluate(() => window.__ccState.e2.session.media.cur);
  await expect.poll(() => b.evaluate(() => window.__ccState.e2.session.media.cur), { timeout: 10_000 }).toBe(cur);
  const [v0, a0] = [await decoded(b, 'video'), await decoded(b, 'audio')];
  await expect.poll(async () => (await decoded(b, 'video')) - v0, { timeout: 15_000 }).toBeGreaterThan(10);
  await expect.poll(async () => (await decoded(b, 'audio')) - a0, { timeout: 15_000 }).toBeGreaterThan(10);
  const stats = await a.evaluate(() => window.__cc.e2ee);
  expect(stats.fail).toBe(0);
  console.log('coût chiffrement (ms/trame) : enc', (stats.encMs / stats.enc).toFixed(3), 'dec', (stats.decMs / stats.dec).toFixed(3));
  for (const x of ctx.slice(0, 2)) await x.close();
});

test('E2EE : repli JPEG + ADPCM chiffré', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  const seenA = spy(a);
  const url = await createRoom(a, 'Repli chiffré');
  await joinRoom(a, url, 'Alice');
  const u = new URL(url); await b.goto(`${u.origin}${u.pathname}?force=jpeg,adpcm${u.hash}`);
  await joinRoom(b, b.url(), 'Vieux');
  await waitMedia(a, { video: 5 }); await waitMedia(b, { video: 5 });
  expect(await a.evaluate(() => window.__cc.codecs)).toEqual({ video: 'jpeg', audio: 'adpcm' });
  const jpeg = seenA.bin.filter(x => x[0] === 1 && x[5] === 3);
  expect(jpeg.length).toBeGreaterThan(3);
  expect(jpeg.some(x => x[12] === 0xff && x[13] === 0xd8)).toBe(false); // pas de JPEG lisible
  expect(jpeg.some(x => x.includes(Buffer.from('JFIF')))).toBe(false);
  await ca.close(); await cb.close();
});

test('E2EE : lien sans clé → « Lien incomplet » ; mauvaise clé → « Clé invalide » ; flux mal chiffré signalé', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  const url = await createRoom(a, 'Clés test');
  const bare = url.split('#')[0];
  await b.goto(bare);
  await expect(b.locator('#keyProblem h2')).toHaveText('Lien incomplet');
  await expect(b.locator('#joinBtn')).toHaveCount(0);
  await b.goto(bare + '#k=' + crypto.randomBytes(32).toString('base64url')); await b.reload();
  await expect(b.locator('#keyProblem h2')).toHaveText('Clé invalide');
  await b.goto(bare + '#k=abc'); await b.reload();
  await expect(b.locator('#keyProblem h2')).toHaveText('Clé invalide');
  // Coller le lien complet répare
  await b.fill('#fullLink', url); await b.click('#keyProblem button[type=submit]');
  await expect(b.locator('#joinBtn')).toBeVisible();
  // Lien sans clé mais déjà visité : clé retrouvée dans ce navigateur (Récents)
  await b.goto(bare); await expect(b.locator('#joinBtn')).toBeVisible();
  await joinRoom(a, url, 'Alice'); await joinRoom(b, b.url(), 'Bruno');
  await waitMedia(b, { video: 5, audio: 5 });
  // Bruno a une clé média faussée : échec propre, signalé sur la vignette d'Alice
  await b.evaluate(() => { const m = window.__ccState.e2.session.media; for (const t of m.epochs.keys()) m.epochs.set(t, new Uint8Array(32)); m.kc.clear(); });
  await expect(b.locator('.tile .pill', { hasText: 'Déchiffrement impossible' })).toBeVisible({ timeout: 15_000 });
  await ca.close(); await cb.close();
});

test('E2EE : salon privé avec mot de passe (lien + mot de passe), historique déchiffré', async ({ browser }) => {
  const ca = await browser.newContext(), cb = await browser.newContext();
  const a = await ca.newPage(), b = await cb.newPage();
  const url = await createRoom(a, 'Coffre chiffré', { password: 'sesame-1234' });
  expect(url).toContain('#k=');
  await joinRoom(a, url, 'Alice');
  await expect(a.locator('#grid')).toBeVisible();
  await a.fill('#chatIn', 'Avant ton arrivée'); await a.press('#chatIn', 'Enter');
  await expect(a.locator('.msg', { hasText: 'Avant ton arrivée' })).toBeVisible();
  const info = await a.evaluate(s => fetch('/api/rooms/' + s).then(r => r.json()), new URL(url).pathname.split('/')[2]);
  expect(info.e2ee.mode).toBe('link+pw'); expect(info.ai).toBe(false);
  await b.goto(url);
  const anon = await b.evaluate(s => fetch('/api/rooms/' + s).then(r => r.json()), new URL(url).pathname.split('/')[2]);
  expect(anon.e2ee.kcv).toBeUndefined(); // pas de test hors ligne du mot de passe avant l'accès
  await joinRoom(b, url, 'Intrus', 'mauvais');
  await expect(b.locator('#joinErr')).toContainText('incorrect');
  await b.fill('#pw', 'sesame-1234'); await b.click('#joinBtn');
  await expect(b.locator('#grid')).toBeVisible();
  await expect(b.locator('.msg', { hasText: 'Avant ton arrivée' })).toBeVisible();
  await waitMedia(b, { audio: 3 });
  expect(readStore(url).msgs).not.toContain('Avant ton arrivée');
  expect(fs.readFileSync(path.join(DATA, 'rooms.json'), 'utf8')).not.toContain('sesame');
  await ca.close(); await cb.close();
});

test('salon public : pas de chiffrement de bout en bout, et c\'est affiché', async ({ browser }) => {
  const ca = await browser.newContext(); const a = await ca.newPage();
  await a.goto('/'); await a.click('#chipPrivate');
  await expect(a.locator('#chipE2ee')).toBeDisabled();
  await expect(a.locator('#e2eeNote')).toContainText('Salon public : pas de chiffrement de bout en bout');
  const url = await createRoom(a, 'Place du village', { isPublic: true });
  expect(url).not.toContain('#');
  await expect(a.locator('#e2eeBadge')).toContainText('Salon public : pas de chiffrement de bout en bout');
  await expect(a.locator('#e2eeHint')).toContainText('pas de chiffrement de bout en bout');
  await joinRoom(a, url, 'Alice');
  await a.fill('#chatIn', 'Message public'); await a.press('#chatIn', 'Enter');
  await expect(a.locator('.msg', { hasText: 'Message public' })).toBeVisible();
  expect(readStore(url).msgs).toContain('Message public');
  await ca.close();
});

test('performance : charge chiffrée d\'un appel à 25 sur un téléphone modeste (processeur ralenti ×6)', async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
  const page = await ctx.newPage(); await page.goto('/');
  const cdp = await ctx.newCDPSession(page); await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  const r = await page.evaluate(async () => {
    const E = await import('/js/e2ee.js');
    const keys = await E.RoomKeys.create(E.rand(32), E.rand(16));
    const frame = n => { const u = new Uint8Array(E.HEADER + n); crypto.getRandomValues(u); return u; };
    // 24 autres personnes : vignettes 15 i/s (~1,2 Ko), son de tout le monde 50 trames/s (~80 o, pire cas) ; plus ma caméra et mon micro.
    const senders = Array.from({ length: 24 }, () => new E.MediaCrypto(keys));
    const rx = new E.MediaCrypto(keys), me = new E.MediaCrypto(keys);
    const inbound = [];
    for (const s of senders) { for (let i = 0; i < 15; i++) inbound.push([await s.encrypt(frame(1200)), s.nonce]); for (let i = 0; i < 50; i++) inbound.push([await s.encrypt(frame(80)), s.nonce]); }
    for (let k = 0; k < 24; k++) await rx.decrypt(...inbound[k]); // dérivation des clés (une fois par personne)
    const t0 = performance.now();
    await Promise.all(inbound.slice(24).map(([f, n]) => rx.decrypt(f, n)));
    const mine = []; for (let i = 0; i < 30; i++) mine.push(me.encrypt(frame(4000))); for (let i = 0; i < 50; i++) mine.push(me.encrypt(frame(80)));
    await Promise.all(mine);
    const ms = performance.now() - t0;
    return { frames: inbound.length - 24 + 80, ms };
  });
  const share = r.ms / 1000;
  console.log(`25 personnes, mobile ×6 : ${r.frames} trames chiffrées/déchiffrées par seconde d'appel en ${r.ms.toFixed(0)} ms (${(share * 100).toFixed(1)} % d'un cœur)`);
  expect(share).toBeLessThan(0.25);
  await ctx.close();
});
