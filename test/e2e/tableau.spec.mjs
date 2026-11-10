// 1.7 : « Vu » dans le chat et tableau blanc partagé, à plusieurs navigateurs dans le même salon.
import { test, expect } from '@playwright/test';
import { createRoom, joinRoom } from './helpers.mjs';

async function people(browser, n, opts = {}) {
  const pages = [];
  for (let i = 0; i < n; i++) pages.push(await (await browser.newContext()).newPage());
  const url = await createRoom(pages[0], 'Tableau ' + Date.now(), opts);
  const names = ['Alice', 'Bruno', 'Chloé', 'David'];
  for (let i = 0; i < n; i++) { await joinRoom(pages[i], url, names[i], opts.password); await expect(pages[i].locator('#dock')).toBeVisible(); }
  await expect(pages[0].locator('.tile')).toHaveCount(n);
  return { pages, url, close: () => Promise.all(pages.map(p => p.context().close())) };
}
const openChat = async p => { if (!(await p.locator('#chatIn').isVisible())) await p.click('#dChat'); await expect(p.locator('#chatIn')).toBeVisible(); };
const closeChat = async p => { if (await p.locator('#chatIn').isVisible()) await p.click('#dChat'); await expect(p.locator('#chatIn')).toBeHidden(); };
const send = async (p, text) => { await p.fill('#chatIn', text); await p.press('#chatIn', 'Enter'); };
async function draw(p, pts) {
  const box = await p.locator('.tile.board:not(.small) .wbpaper').boundingBox();
  const at = ([x, y]) => [box.x + x * box.width, box.y + y * box.height];
  await p.mouse.move(...at(pts[0])); await p.mouse.down();
  for (const q of pts.slice(1)) await p.mouse.move(...at(q), { steps: 6 });
  await p.mouse.up();
}
const items = p => p.evaluate(() => window.__ccState.wb?.view?.items.map(s => ({ id: s.id, k: s.k, c: s.c, n: s.p.length })) || null);
// pixels encrés dans la zone de dessin (canvas de base)
const inked = p => p.evaluate(() => {
  const c = document.querySelector('.tile.board .wbc'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0; for (let i = 3; i < d.length; i += 16) if (d[i] > 40) n++; return n;
});

for (const [label, opts] of [['chiffré de bout en bout', {}], ['public', { isPublic: true }]]) {
  test(`Vu : n'apparaît que lorsque le message est réellement lu (salon ${label})`, async ({ browser }) => {
    const { pages: [a, b, c], close } = await people(browser, 3, opts);
    await openChat(a); await closeChat(b); await closeChat(c);
    await send(a, 'Tu as vu le plan ?');
    const mine = a.locator('.msg.mine').last();
    await expect(mine).toContainText('Tu as vu le plan');
    await a.waitForTimeout(1500);
    await expect(mine.locator('.seen')).toBeHidden(); // panneau fermé chez B et C : pas lu
    await openChat(b);
    await expect(mine.locator('.seen')).toHaveText(/Vu par Bruno/);
    await openChat(c);
    await expect(mine.locator('.seen .sl')).toHaveText('Vu par 2');
    await expect(mine.locator('.seen')).toHaveAttribute('title', 'Vu par Bruno, Chloé');
    await mine.locator('.seen').click();
    await expect(mine.locator('.seen .who')).toHaveText('Bruno, Chloé');
    // jamais de « Vu » sous les messages des autres
    await expect(b.locator('.msg:not(.mine) .seen')).toHaveCount(0);
    // onglet en arrière-plan : pas d'accusé
    await b.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); });
    await c.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); });
    await send(a, 'Deuxième');
    await expect(b.locator('.msg', { hasText: 'Deuxième' })).toBeVisible();
    await a.waitForTimeout(1500);
    await expect(a.locator('.msg.mine', { hasText: 'Deuxième' }).locator('.seen')).toBeHidden();
    await b.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await expect(a.locator('.msg.mine', { hasText: 'Deuxième' }).locator('.seen')).toHaveText(/Vu par Bruno/);
    // l'ancien message (mêmes lecteurs → seul le plus récent affiche « Vu ») reste cohérent
    // après rechargement chez l'auteur : historique et accusés restitués
    await a.reload(); await joinRoom(a, a.url(), 'Alice', opts.password);
    await expect(a.locator('#dock')).toBeVisible(); await expect(a.locator('.msg.mine', { hasText: 'Deuxième' })).toBeAttached(); await openChat(a);
    await expect(a.locator('.msg.mine', { hasText: 'Deuxième' }).locator('.seen')).toHaveText(/Vu par Bruno/);
    await expect(a.locator('.msg.mine', { hasText: 'Tu as vu le plan' }).locator('.seen')).toHaveText(/Vu par 2/);
    await close();
  });
}

test('Tableau blanc : A dessine, B voit en direct, C arrivé après reçoit tout (chiffré de bout en bout)', async ({ browser }) => {
  const { pages: [a, b], url, close } = await people(browser, 2);
  for (const p of [a, b]) await closeChat(p);
  await a.click('#dBoard');
  for (const p of [a, b]) await expect(p.locator('.tile.board:not(.small)')).toBeVisible();
  await expect(b.locator('.tile.board .lab')).toHaveText(/Tableau blanc d'Alice|Tableau blanc de Alice/);
  await expect(a.locator('#grid.spot > .tile.board')).toBeVisible(); // grande vue, comme un partage d'écran
  // B voit le trait en cours avant qu'il soit fini (fragments en direct)
  const box = await a.locator('.wbpaper').boundingBox();
  await a.mouse.move(box.x + box.width * .1, box.y + box.height * .2); await a.mouse.down();
  for (let i = 1; i <= 12; i++) await a.mouse.move(box.x + box.width * (.1 + i * .03), box.y + box.height * (.2 + i * .02), { steps: 3 });
  await expect.poll(() => b.evaluate(() => window.__ccState.wb.view.live.size)).toBe(1);
  await expect(b.locator('.wbtag')).toHaveText('Alice');
  await a.mouse.up();
  await expect.poll(async () => (await items(b))?.length).toBe(1);
  // formes, couleur, gomme
  await a.click('[data-tool="rect"]'); await a.click('[data-col="2"]');
  await draw(a, [[.5, .3], [.8, .7]]);
  await a.click('[data-tool="arrow"]'); await draw(a, [[.2, .8], [.45, .55]]);
  await b.click('[data-tool="ellipse"]'); await draw(b, [[.6, .1], [.9, .4]]);
  await expect.poll(async () => (await items(a))?.map(s => s.k)).toEqual(['pen', 'rect', 'arrow', 'ellipse']);
  expect((await items(b)).map(s => s.k)).toEqual(['pen', 'rect', 'arrow', 'ellipse']);
  expect((await items(b))[1].c).toBe(2);
  expect(await inked(b)).toBeGreaterThan(200);
  // annuler : seulement ses propres traits (B annule son ellipse, pas ceux d'A)
  await b.click('.wbb[aria-label^="Annuler"]');
  await expect.poll(async () => (await items(a)).map(s => s.k)).toEqual(['pen', 'rect', 'arrow']);
  await expect(b.locator('.wbb[aria-label^="Annuler"]')).toBeDisabled(); // B n'a plus rien à annuler
  await b.click('.wbb[aria-label^="Rétablir"]');
  await expect.poll(async () => (await items(a)).map(s => s.k)).toEqual(['pen', 'rect', 'arrow', 'ellipse']);
  // C arrive : état rejoué (déchiffré avec la clé du lien)
  const c = await (await browser.newContext()).newPage();
  await joinRoom(c, url, 'Chloé');
  await expect(c.locator('.tile.board:not(.small)')).toBeVisible();
  await expect.poll(async () => (await items(c))?.map(s => s.k)).toEqual(['pen', 'rect', 'arrow', 'ellipse']);
  expect(await inked(c)).toBeGreaterThan(200);
  expect(await c.evaluate(() => window.__cc.errors.filter(e => /wb|e2ee/.test(e)))).toEqual([]);
  // verrou : seule Alice dessine ; les autres voient l'état
  await expect(b.locator('[aria-label^="Verrouiller"]')).toBeHidden();
  await a.click('.wbb[title^="Verrouiller"]');
  await expect(c.locator('.wbstatus')).toHaveText(/Verrouillé par Alice/);
  await draw(c, [[.1, .1], [.3, .3], [.5, .2]]);
  await c.waitForTimeout(500);
  expect((await items(a)).length).toBe(4);
  await a.click('.wbb[title^="Déverrouiller"]');
  await expect(c.locator('.wbstatus')).toBeHidden();
  // export PNG
  const [dl] = await Promise.all([a.waitForEvent('download'), a.click('.wbb[aria-label="Exporter en PNG"]')]);
  expect(dl.suggestedFilename()).toMatch(/^tableau-blanc-.*\.png$/);
  // tout effacer puis fermer : réservé à Alice, avec confirmation
  await a.click('.wbb[aria-label="Tout effacer"]'); await a.click('.modal .btn.danger');
  await expect.poll(async () => (await items(c)).length).toBe(0);
  await a.click('#dBoard'); await a.click('.modal .btn.danger');
  for (const p of [a, b, c]) await expect(p.locator('.tile.board')).toHaveCount(0);
  await c.context().close(); await close();
});

test('Tableau blanc : salon public, coexistence avec l\'épinglage et taille d\'écran différente', async ({ browser }) => {
  const { pages: [a, b], close } = await people(browser, 2, { isPublic: true });
  await b.setViewportSize({ width: 900, height: 700 });
  await b.click('#dBoard');
  await expect(a.locator('#grid.spot > .tile.board')).toBeVisible();
  await draw(b, [[.25, .25], [.75, .75]]);
  await expect.poll(async () => (await items(a))?.length).toBe(1);
  // mêmes coordonnées normalisées quelle que soit la taille affichée
  const [pa, pb] = await Promise.all([a, b].map(p => p.evaluate(() => window.__ccState.wb.view.items[0].p.slice(0, 2))));
  expect(pa).toEqual(pb);
  // A épingle la caméra de B : le tableau passe en vignette (lecture seule), un clic le remet en grand
  await a.locator('.tile[data-key^="p:"]:not(.me)').dblclick();
  await expect(a.locator('.strip .tile.board.small')).toBeVisible();
  await a.locator('.tile.board.small').click();
  await expect(a.locator('#grid.spot > .tile.board')).toBeVisible();
  // un deuxième tableau est refusé
  await a.click('#dBoard');
  await expect(a.locator('#grid.spot > .tile.board')).toBeVisible();
  await expect(a.locator('.tile.board')).toHaveCount(1);
  await close();
});

test('Tableau blanc sur téléphone : ouverture par le menu, dessin au doigt (événements tactiles réels)', async ({ browser }) => {
  const desk = await (await browser.newContext()).newPage();
  const url = await createRoom(desk, 'Mobile ' + Date.now());
  await joinRoom(desk, url, 'Alice');
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' });
  const m = await ctx.newPage();
  await joinRoom(m, url, 'Bruno');
  await expect(m.locator('#dock')).toBeVisible();
  await expect(m.locator('#dBoard')).toBeHidden(); // dock compact : le tableau est dans « Plus d'options »
  await m.click('#dMore'); await m.locator('.menuitem', { hasText: 'Tableau blanc' }).click();
  await expect(m.locator('.tile.board:not(.small) .wbpaper')).toBeVisible();
  expect(await m.locator('.wbpaper').evaluate(e => getComputedStyle(e).touchAction)).toBe('none');
  const box = await m.locator('.wbpaper').boundingBox();
  const cdp = await ctx.newCDPSession(m);
  const tp = (x, y) => [{ x: box.x + x * box.width, y: box.y + y * box.height, id: 1, radiusX: 4, radiusY: 4, force: 0.5 }];
  const scrollBefore = await m.evaluate(() => document.scrollingElement.scrollTop);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(.2, .3) });
  for (let i = 1; i <= 15; i++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(.2 + i * .04, .3 + i * .02) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect.poll(async () => (await items(desk))?.length).toBe(1);
  expect((await items(desk))[0].n).toBeGreaterThan(10);
  expect(await m.evaluate(() => document.scrollingElement.scrollTop)).toBe(scrollBefore); // le doigt dessine, la page ne défile pas
  await ctx.close(); await desk.context().close();
});
