// Captures d'écran de l'application réelle (bureau 1440x900, mobile 390x844) avec caméras simulées.
import { chromium } from '@playwright/test';
const BASE = process.env.BASE || 'http://localhost:8795';
const OUT = process.env.OUT || '/workspace';
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args });
const desk = { viewport: { width: 1440, height: 900 }, locale: 'fr-FR' };
const mob = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'fr-FR',
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36' };
const shot = (p, n) => p.screenshot({ path: `${OUT}/chatsysvisio-${n}.png` });
const wait = ms => new Promise(r => setTimeout(r, ms));

async function ctx(opts, name) {
  const c = await browser.newContext(opts); const p = await c.newPage();
  await p.goto(BASE + '/'); await p.evaluate(n => localStorage.setItem('cc-name', n), name); return p;
}
// Accueil
const a = await ctx(desk, 'Alice');
await a.request.post(BASE + '/api/rooms', { headers: { 'X-CSRF-Token': (await (await a.request.get(BASE + '/api/session')).json()).csrf, Origin: BASE }, data: { name: 'Club lecture', isPublic: true } });
await a.goto(BASE + '/'); await wait(600); await shot(a, 'accueil');
await a.evaluate(() => { localStorage.setItem('cc-theme', 'light'); }); await a.reload(); await wait(500); await shot(a, 'accueil-clair');
await a.evaluate(() => { localStorage.setItem('cc-theme', 'dark'); });
// Création d'un salon + lobby
await a.goto(BASE + '/'); await a.fill('#roomName', 'Club photo'); await a.click('#go'); await a.waitForURL(/\/r\//);
const url = a.url(); await wait(1500); await shot(a, 'lobby');
await a.click('#joinBtn'); await a.waitForSelector('#grid');
const peers = [];
for (const n of ['Bob', 'Hugo', 'Léa Martin']) { const p = await ctx(desk, n); await p.goto(url); await p.click('#joinBtn'); await p.waitForSelector('#grid'); peers.push(p); }
await wait(2500);
await peers[0].fill('#chatIn', 'Coucou ! Vous m\'entendez bien ? 👋'); await peers[0].press('#chatIn', 'Enter');
await peers[1].fill('#chatIn', 'Oui très bien. Je partage le **planning** du week-end :'); await peers[1].press('#chatIn', 'Enter');
await peers[1].locator('#fileIn').setInputFiles({ name: 'planning-weekend.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%fake\n') });
await wait(800);
await a.locator('.msg', { hasText: 'Coucou' }).hover();
await peers[2].evaluate(() => document.querySelector('#dHand').click());
await wait(1500); await shot(a, 'appel');
await a.evaluate(() => { localStorage.setItem('cc-theme', 'light'); document.documentElement.classList.add('light'); }); await wait(300); await shot(a, 'appel-clair');
await a.evaluate(() => { localStorage.setItem('cc-theme', 'dark'); document.documentElement.classList.remove('light'); });
await a.click('#inviteBtn'); await wait(400); await shot(a, 'invitation'); await a.keyboard.press('Escape');
// Mobile
const m = await ctx(mob, 'Inès');
await m.goto(BASE + '/'); await wait(500); await shot(m, 'mobile-accueil');
await m.goto(url); await wait(1500); await shot(m, 'mobile-lobby');
await m.click('#joinBtn'); await m.waitForSelector('#grid'); await wait(3000); await shot(m, 'mobile-appel');
await m.click('#dChat'); await wait(500); await shot(m, 'mobile-messages');
await m.click('.ph-close'); await m.click('#dMore'); await wait(300); await shot(m, 'mobile-menu');
await a.goto(BASE + '/public'); await wait(500); await shot(a, 'publics');
await browser.close();
console.log('captures OK');
