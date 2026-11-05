// Captures de design (avant/après) : accueil, salon (lobby + appel + chiffrement), admin. Bureau 1440x900 et mobile 390x844.
// Usage : serveur lancé sur BASE avec DATA_DIR=$DATA ; PREFIX=avant|apres node scripts/design-shots.mjs
import { chromium } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { totp } from '../server/totp.mjs';
const BASE = process.env.BASE || 'http://localhost:8796';
const OUT = process.env.OUT || '/workspace';
const PREFIX = process.env.PREFIX || 'apres';
const DATA = process.env.DATA || '/tmp/cc-design';
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args });
const desk = { viewport: { width: 1440, height: 900 }, locale: 'fr-FR', colorScheme: 'dark' };
const mob = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR', colorScheme: 'dark',
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36' };
// la souris bouge avant chaque capture : en appel, l'en-tête et le dock s'effacent après 3,5 s d'inactivité
const shot = async (p, n, { idle = false, at = [1100, 120] } = {}) => {
  if (!idle && (p.viewportSize()?.width || 0) > 760) { await p.mouse.move(at[0], at[1]).catch(() => {}); await p.mouse.move(at[0] + 2, at[1] + 1).catch(() => {}); await new Promise(r => setTimeout(r, 320)); }
  await p.screenshot({ path: `${OUT}/design-${PREFIX}-${n}.png` });
};
const wait = ms => new Promise(r => setTimeout(r, ms));
async function ctx(opts, name) {
  const c = await browser.newContext(opts); const p = await c.newPage();
  await p.goto(BASE + '/'); await p.evaluate(n => { localStorage.setItem('cc-name', n); localStorage.setItem('cc-theme', 'dark'); }, name); return p;
}
const theme = async (p, t) => { await p.evaluate(t => { localStorage.setItem('cc-theme', t); document.documentElement.classList.toggle('light', t === 'light'); }, t); await wait(350); };

const a = await ctx(desk, 'Alice');
const csrf = (await (await a.request.get(BASE + '/api/session')).json()).csrf;
await a.request.post(BASE + '/api/rooms', { headers: { 'X-CSRF-Token': csrf, Origin: BASE }, data: { name: 'Club lecture', isPublic: true } });
await a.goto(BASE + '/'); await wait(700); await shot(a, 'accueil-bureau');
await theme(a, 'light'); await shot(a, 'accueil-bureau-clair'); await theme(a, 'dark');
await a.goto(BASE + '/'); await a.fill('#roomName', 'Club photo'); await a.click('#go'); await a.waitForURL(/\/r\//);
const url = a.url(); await wait(1500); await shot(a, 'lobby-bureau');
await a.click('#joinBtn'); await a.waitForSelector('#grid');
const peers = [];
for (const n of ['Bob', 'Hugo', 'Léa Martin']) { const p = await ctx(desk, n); await p.goto(url); await p.click('#joinBtn'); await p.waitForSelector('#grid'); peers.push(p); }
await wait(2500);
await peers[0].fill('#chatIn', 'Coucou ! Vous m\'entendez bien ?'); await peers[0].press('#chatIn', 'Enter');
await peers[1].fill('#chatIn', 'Oui très bien. Je partage le **planning** du week-end :'); await peers[1].press('#chatIn', 'Enter');
await peers[1].locator('#fileIn').setInputFiles({ name: 'planning-weekend.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%fake\n') });
await wait(800);
await peers[2].evaluate(() => document.querySelector('#dHand').click());
await a.fill('#chatIn', 'Parfait, merci Hugo !'); await a.press('#chatIn', 'Enter');
await a.fill('#chatIn', 'On commence dans 5 minutes.'); await a.press('#chatIn', 'Enter');
await wait(1800); await shot(a, 'appel-bureau');
// mode orateur (bascule grille / orateur dans l'en-tête) + info-bulle du dock
await a.click('#viewSeg [data-view="speaker"]'); await wait(900);
const mic = await a.locator('#dMic').boundingBox();
await shot(a, 'appel-orateur-bureau', { at: [mic.x + mic.width / 2, mic.y + mic.height / 2] }); await wait(600);
await a.screenshot({ path: `${OUT}/design-${PREFIX}-appel-orateur-bureau.png` });
await a.mouse.move(700, 400); await wait(4300); await shot(a, 'appel-repos-bureau', { idle: true });
await a.mouse.move(600, 300); await wait(300); await a.click('#viewSeg [data-view="grid"]'); await wait(600);
await theme(a, 'light'); await shot(a, 'appel-bureau-clair'); await theme(a, 'dark');
await a.click('#e2eeBadge'); await wait(450); await shot(a, 'chiffrement-bureau'); await a.keyboard.press('Escape'); await wait(300);
await a.click('#dMore'); await wait(300); await shot(a, 'menu-bureau');
await a.locator('.menuitem', { hasText: 'Infos techniques' }).click(); await wait(450); await shot(a, 'infos-bureau'); await a.keyboard.press('Escape');
// Mobile
const m = await ctx(mob, 'Inès');
await m.goto(BASE + '/'); await wait(600); await shot(m, 'accueil-mobile');
await m.goto(url); await wait(1500); await shot(m, 'lobby-mobile');
await m.click('#joinBtn'); await m.waitForSelector('#grid'); await wait(3000); await shot(m, 'appel-mobile');
await m.click('#dChat'); await wait(500); await shot(m, 'chat-mobile');
await m.click('.ph-close'); await m.click('#dMore'); await wait(400); await shot(m, 'menu-mobile');
await m.goto(BASE + '/compte'); await wait(600); await shot(m, 'compte-mobile');
await a.goto(BASE + '/public'); await wait(600); await shot(a, 'publics-bureau');
await a.goto(BASE + '/compte'); await wait(600); await shot(a, 'compte-bureau');
// Admin
const PW = 'phrase-admin-design-solide';
const adm = JSON.parse(execFileSync('node', ['scripts/chatsysvisio-admin.mjs', 'create-admin', '--user', 'admin', '--data-dir', DATA, '--password-stdin', '--no-verify', '--json', '--force'], { input: PW + '\n' }).toString());
const ad = await ctx(desk, 'x');
await ad.goto(BASE + '/admin/'); await ad.waitForSelector('#loginForm'); await wait(400); await shot(ad, 'admin-connexion-bureau');
await ad.fill('#user', 'admin'); await ad.fill('#password', PW); await ad.fill('#code', totp(adm.secret)); await ad.click('#loginForm button[type=submit]');
await ad.waitForSelector('#shell:not([hidden])'); await wait(2500); await shot(ad, 'admin-bureau');
await ad.click('#nav a[href="#rooms"]'); await wait(800); await shot(ad, 'admin-salons-bureau');
await ad.click('#nav a[href="#settings"]'); await wait(800); await shot(ad, 'admin-reglages-bureau');
const cookies = await ad.context().cookies();
const am = await browser.newContext(mob); await am.addCookies(cookies); const amp = await am.newPage();
await amp.goto(BASE + '/admin/'); await amp.waitForSelector('#shell:not([hidden])'); await wait(2500); await shot(amp, 'admin-mobile');
await amp.goto(BASE + '/admin/#rooms'); await wait(1200); await shot(amp, 'admin-salons-mobile');
await browser.close();
console.log('captures OK');
