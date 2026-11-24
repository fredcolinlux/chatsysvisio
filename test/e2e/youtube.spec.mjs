// 1.13 : lecteur YouTube partagé — ouverture, synchronisation, arrivant en retard, droits (une seule personne partage
// et pilote), volume individuel, erreurs. Le lecteur YouTube est bouchonné (youtube-stub.mjs) : même protocole postMessage.
import { test, expect } from '@playwright/test';
import { createRoom, joinRoom } from './helpers.mjs';
import { stubYouTube, stubState, ytFrame } from './youtube-stub.mjs';

const names = ['Alice', 'Bruno', 'Chloé'];
async function person(browser, url, i, opts = {}) {
  const ctx = await browser.newContext(opts.ctx || {}); await stubYouTube(ctx, opts.stub);
  const p = await ctx.newPage();
  if (!url) url = await createRoom(p, 'Vidéo ' + Date.now(), opts.room);
  await joinRoom(p, url, names[i]); await expect(p.locator('#dock')).toBeVisible();
  return { p, url };
}
async function share(p, link) {
  await p.click('#dYt');
  await expect(p.locator('#ytUrl')).toBeVisible();
  await p.fill('#ytUrl', link); await p.click('#ytGo');
}
const st = p => stubState(p);
const until = (p, fn, label, timeout = 15000) => expect.poll(async () => { const s = await st(p); return s && fn(s) ? 'ok' : JSON.stringify(s && { id: s.id, now: +s.now.toFixed(2), state: s.state, rate: s.rate, vol: s.vol, muted: s.muted }); }, { timeout, intervals: [250], message: label }).toBe('ok');

for (const [label, room] of [['chiffré de bout en bout', {}], ['public', { isPublic: true }]]) {
  test(`YouTube : partage, synchronisation et arrivant en retard (salon ${label})`, async ({ browser }) => {
    const { p: a, url } = await person(browser, null, 0, { room });
    const { p: b } = await person(browser, url, 1);
    await share(a, 'https://youtu.be/dQw4w9WgXcQ?t=42');
    for (const p of [a, b]) await expect(p.locator('.ytbox iframe.ytif')).toBeVisible();
    // le cadre : identifiant seul, lecture en ligne, API postMessage, bac à sable et permissions minimales
    const src = await b.locator('.ytbox iframe').getAttribute('src');
    expect(src).toMatch(/^https:\/\/www\.youtube-nocookie\.com\/embed\/dQw4w9WgXcQ\?/);
    expect(src).toContain('playsinline=1'); expect(src).toContain('enablejsapi=1'); expect(src).toContain('controls=0');
    expect(await a.locator('.ytbox iframe').getAttribute('src')).toContain('controls=1');
    expect(await b.locator('.ytbox iframe').getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-presentation');
    expect(await b.locator('.ytbox iframe').getAttribute('allow')).toBe('autoplay; encrypted-media; fullscreen');
    expect(await b.locator('.ytbox iframe').getAttribute('referrerpolicy')).toBe('strict-origin-when-cross-origin');
    await until(a, s => s.id === 'dQw4w9WgXcQ' && s.state === 1 && s.now >= 42, 'lecture chez Alice');
    await until(b, s => s.id === 'dQw4w9WgXcQ' && s.state === 1 && s.now >= 42, 'lecture chez Bruno');
    await expect(b.locator('.ytwho')).toHaveText('Partagée par Alice');
    await expect(a.locator('.ytwho')).toHaveText('Tu partages cette vidéo');
    // pause, saut, vitesse : faits dans le lecteur d'Alice, suivis chez Bruno
    await ytFrame(a).evaluate(() => window.userPause());
    await until(b, s => s.state === 2, 'pause chez Bruno', 6000);
    const pa = (await st(a)).now, pb = (await st(b)).now;
    expect(Math.abs(pa - pb)).toBeLessThan(0.6);
    await ytFrame(a).evaluate(() => { window.userSeek(200); window.userPlay(); });
    await until(b, s => s.state === 1 && Math.abs(s.now - 200) < 2, 'saut à 200 s chez Bruno', 8000);
    await ytFrame(a).evaluate(() => window.userRate(1.5));
    await until(b, s => s.rate === 1.5, 'vitesse 1,5 chez Bruno', 6000);
    // dérive : Bruno décroche de 5 s → recalé (> 1,5 s d'écart)
    await ytFrame(b).evaluate(() => window.userSeek(window.__stub.t - 5));
    await a.waitForTimeout(300);
    await expect.poll(async () => Math.abs((await st(a)).now - (await st(b)).now), { timeout: 8000 }).toBeLessThan(1.5);
    // arrivant en retard : même vidéo, même position, même vitesse
    const { p: c } = await person(browser, url, 2);
    await expect(c.locator('.ytbox iframe.ytif')).toBeVisible();
    await until(c, s => s.id === 'dQw4w9WgXcQ' && s.state === 1 && s.rate === 1.5, 'arrivée de Chloé');
    await expect.poll(async () => Math.abs((await st(a)).now - (await st(c)).now), { timeout: 8000 }).toBeLessThan(1.5);
    // pas de boucle d'écho : les spectateurs n'envoient jamais d'état
    const sent = await b.evaluate(() => window.__ccYtSent || 0); expect(sent).toBe(0);
    // changement de vidéo par Alice
    await share(a, 'https://www.youtube.com/shorts/aqz-KE-bpKQ');
    await until(b, s => s.id === 'aqz-KE-bpKQ', 'nouvelle vidéo chez Bruno');
    await until(c, s => s.id === 'aqz-KE-bpKQ', 'nouvelle vidéo chez Chloé');
    await Promise.all([a, b, c].map(p => p.context().close()));
  });
}

test('YouTube : une seule personne partage et pilote ; arrêt quand elle quitte', async ({ browser }) => {
  const { p: a, url } = await person(browser, null, 0, { room: { isPublic: true } });
  const { p: b } = await person(browser, url, 1);
  await share(a, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  await until(b, s => s.state === 1, 'lecture chez Bruno');
  // Bruno ne peut ni partager une autre vidéo, ni piloter : refus clair
  await b.click('#dYt');
  await expect(b.locator('.toast').last()).toContainText('Alice partage déjà une vidéo YouTube');
  await expect(b.locator('#ytUrl')).toHaveCount(0);
  await expect(b.locator('.ytbar .stop')).toHaveCount(0);
  // tentative directe (client modifié) : le serveur refuse ouverture, état et arrêt
  await b.evaluate(() => { const e = window.__ccState.engine; e.send({ t: 'yt', op: 'open', s: { id: 'aqz-KE-bpKQ', pos: 0, play: true, rate: 1, n: 0 } }); e.send({ t: 'yt', op: 'state', s: { id: 'dQw4w9WgXcQ', pos: 500, play: false, rate: 2, n: 9 } }); e.send({ t: 'yt', op: 'close' }); });
  await expect(b.locator('.toast', { hasText: 'il faut d\'abord qu\'il arrête son partage' }).first()).toBeVisible();
  await a.waitForTimeout(1200);
  const sa = await st(a); expect(sa.id).toBe('dQw4w9WgXcQ'); expect(sa.state).toBe(1); expect(sa.rate).toBe(1); expect(sa.now).toBeLessThan(100);
  await expect(a.locator('.ytbox')).toBeVisible();
  // le lecteur des spectateurs est protégé (pas de clic dans le lecteur)
  await expect(b.locator('.ytshield')).toBeVisible();
  await expect(a.locator('.ytshield')).toBeHidden();
  // Alice quitte : le partage s'arrête chez Bruno, qui peut alors partager
  await a.context().close();
  await expect(b.locator('.ytbox')).toHaveCount(0, { timeout: 10000 });
  await expect(b.locator('.sysmsg', { hasText: 'Partage YouTube de Alice arrêté' }).first()).toBeAttached();
  await share(b, 'aqz-KE-bpKQ');
  await until(b, s => s.id === 'aqz-KE-bpKQ' && s.state === 1, 'Bruno partage');
  // arrêt par la personne qui partage
  await b.click('.ytbar .stop');
  await expect(b.locator('.ytbox')).toHaveCount(0);
  await b.context().close();
});

test('YouTube : volume et coupure individuels, jamais synchronisés, retenus localement', async ({ browser }) => {
  const { p: a, url } = await person(browser, null, 0);
  const { p: b } = await person(browser, url, 1);
  await share(a, 'https://youtu.be/dQw4w9WgXcQ');
  await until(b, s => s.state === 1, 'lecture chez Bruno');
  await until(a, s => s.vol === 80 && !s.muted, 'volume par défaut chez Alice');
  await b.locator('.ytvol').fill('30');
  await until(b, s => s.vol === 30, 'volume 30 chez Bruno');
  await b.locator('.ytgrp.vol .ytb').click();
  await until(b, s => s.muted, 'Bruno coupé');
  await a.waitForTimeout(1500);
  const sa = await st(a); expect(sa.vol).toBe(80); expect(sa.muted).toBe(false);
  expect(await b.evaluate(() => JSON.parse(localStorage.getItem('csv-ytvol')))).toEqual({ v: 30, m: true });
  // Alice change son propre volume : aucun effet chez Bruno
  await a.locator('.ytvol').fill('55');
  await until(a, s => s.vol === 55, 'Alice 55');
  await b.waitForTimeout(1000);
  const sb = await st(b); expect(sb.vol).toBe(30); expect(sb.muted).toBe(true);
  // retenu après rechargement
  await b.reload(); await joinRoom(b, b.url(), 'Bruno');
  await until(b, s => s.state === 1 && s.vol === 30 && s.muted, 'volume retenu chez Bruno');
  await Promise.all([a, b].map(p => p.context().close()));
});

test('YouTube : lecture muette imposée par le navigateur → « Activer le son »', async ({ browser }) => {
  const { p: a, url } = await person(browser, null, 0, { room: { isPublic: true } });
  const { p: b } = await person(browser, url, 1);
  await share(a, 'AUTOPLAYBLK');
  await expect(b.locator('.ytunmute')).toBeVisible({ timeout: 10000 });
  await until(b, s => s.state === 1 && s.muted, 'lecture muette chez Bruno');
  await ytFrame(b).evaluate(() => { window.__stub.allowUnlock = true; }); // le geste sur « Activer le son » autorise le son
  await b.click('.ytunmute');
  await until(b, s => s.state === 1 && !s.muted, 'son activé chez Bruno');
  await expect(b.locator('.ytunmute')).toBeHidden();
  await Promise.all([a, b].map(p => p.context().close()));
});

test('YouTube : liens refusés, vidéo non intégrable, lecteur bloqué', async ({ browser }) => {
  const { p: a, url } = await person(browser, null, 0, { room: { isPublic: true } });
  await a.click('#dYt'); await a.fill('#ytUrl', 'https://evil.example/watch?v=dQw4w9WgXcQ'); await a.click('#ytGo');
  await expect(a.locator('#ytErr')).toContainText('n\'est pas une vidéo YouTube reconnue');
  await a.fill('#ytUrl', 'https://www.youtube.com/watch?v=NOEMBED0150'); await a.click('#ytGo');
  await expect(a.locator('.ytstatus')).toContainText('n\'autorise pas sa lecture en dehors de YouTube');
  await expect(a.locator('.ytstatus a')).toHaveAttribute('href', 'https://www.youtube.com/watch?v=NOEMBED0150');
  await a.click('.ytbar .stop'); await expect(a.locator('.ytbox')).toHaveCount(0);
  // bloqueur : le cadre ne répond jamais
  const { p: b } = await person(browser, url, 1, { stub: { block: true } });
  await share(a, 'dQw4w9WgXcQ');
  await expect(b.locator('.ytstatus')).toContainText('bloqueur', { timeout: 20000 });
  await Promise.all([a, b].map(p => p.context().close()));
});

test('YouTube : mobile (menu « … », lecture en ligne, barre de volume)', async ({ browser }) => {
  const { p: a, url } = await person(browser, null, 0, { room: { isPublic: true } });
  const { p: m } = await person(browser, url, 1, { ctx: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' } });
  await share(a, 'https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s');
  await until(m, s => s.state === 1 && s.now >= 65 && s.playsinline === '1', 'lecture en ligne sur mobile');
  const box = await m.locator('.ytbox').boundingBox();
  expect(box.width).toBeGreaterThan(300);
  await expect(m.locator('.ytvol')).toBeVisible();
  // sur mobile, le partage passe par le menu « … »
  await m.click('#dMore');
  await expect(m.locator('.menuitem', { hasText: 'Afficher la vidéo YouTube' })).toBeVisible();
  await Promise.all([a, m].map(p => p.context().close()));
});
