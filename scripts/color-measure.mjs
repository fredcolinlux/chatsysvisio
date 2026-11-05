// Mesure de fidélité des couleurs : mire → encodeur → serveur → décodeur → tuile (pixels + capture d'écran).
// Usage : serveur lancé sur BASE ; SHOT=/workspace/couleurs-avant.png node scripts/color-measure.mjs
import { chromium, firefox, webkit } from '@playwright/test';
import { BARS, BOTTOM, mireInit, sampleTile, report } from '../test/e2e/mire.mjs';
const BASE = process.env.BASE || 'http://localhost:8796';
const args = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'];
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args });
const R = process.env.RECV || 'chromium', S = process.env.SEND || 'chromium';
const others = {};
const launch = async n => n === 'chromium' ? browser : (others[n] ||= await ({ firefox, webkit }[n]).launch(n === 'firefox' ? { firefoxUserPrefs: { 'media.navigator.streams.fake': true, 'media.navigator.permission.disabled': true, 'media.autoplay.default': 0 } } : {}));
const wait = ms => new Promise(r => setTimeout(r, ms));
const cases = (process.env.CASES || 'vp8,avc,jpeg,vp8-flou').split(',');
const out = {};
for (const cs of cases) {
  const force = cs.startsWith('avc') ? '?force=avc' : cs.startsWith('jpeg') ? '?force=jpeg' : '';
  const bg = cs.endsWith('flou') ? 'blur' : 'none';
  const ca = await (await launch(S)).newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR' }), cb = await (await launch(R)).newContext({ viewport: { width: 1440, height: 900 }, locale: 'fr-FR' });
  await ca.addInitScript(mireInit, { bars: BARS, bottom: BOTTOM, noise: +(process.env.NOISE || 0), yuv: process.env.YUV ? { matrix: process.env.YUV.split(':')[0], fullRange: process.env.YUV.endsWith(':full') } : null, size: (process.env.SIZE || '1280x720').split('x').map(Number) });
  const a = await ca.newPage(), b = await cb.newPage();
  await a.goto(BASE + '/'); await a.evaluate(bg => localStorage.setItem('cc-bg', bg), bg); if (process.env.QUALITY) await a.evaluate(q => localStorage.setItem('cc-quality', q), process.env.QUALITY);
  await a.fill('#roomName', 'Mire ' + cs); await a.click('#go'); await a.waitForURL(/\/r\//);
  const url = a.url(); const q = u => { const i = u.indexOf('#'); return i < 0 ? u + force : u.slice(0, i) + force + u.slice(i); };
  await a.goto(q(url)); await a.fill('#name', 'Émetteur'); await a.click('#joinBtn');
  await b.goto(q(url)); await b.fill('#name', 'Récepteur'); await b.click('#joinBtn');
  await b.waitForFunction(() => Object.values(window.__cc?.decoded?.video || {}).some(n => n > 40), null, { timeout: 40_000 });
  await wait(4000); // laisse l'encodeur monter en débit
  await b.evaluate(() => document.body.classList.add('idle')); await wait(400);
  const codec = await a.evaluate(() => window.__cc.codecs.video); if (process.env.DEBUG) console.log(cs, JSON.stringify(await b.evaluate(() => window.__cc.colorSpace)), JSON.stringify(await a.evaluate(() => window.__cc.encCs)));
  const raw = await sampleTile(b);
  const shot = await b.screenshot();
  if (process.env.SHOT && cs === cases[0]) (await import('node:fs')).writeFileSync(process.env.SHOT, shot);
  const scr = await sampleTile(b, shot.toString('base64'));
  out[cs] = { codec, size: `${raw.w}x${raw.h}`, tuile: report(raw), ecran: report(scr) };
  await ca.close(); await cb.close();
}
await browser.close(); for (const b of Object.values(others)) await b.close();
for (const [k, v] of Object.entries(out)) {
  console.log(`\n== ${k} (${v.codec}, ${v.size}) tuile: ΔEmoy ${v.tuile.meanDE} ΔEmax ${v.tuile.maxDE} chroma ${v.tuile.chromaRatio} | écran: ΔEmoy ${v.ecran.meanDE} ΔEmax ${v.ecran.maxDE} chroma ${v.ecran.chromaRatio}`);
  for (let i = 0; i < v.tuile.rows.length; i++) { const r = v.tuile.rows[i], e = v.ecran.rows[i]; console.log(`  ${r.n.padEnd(10)} ref ${r.ref.join(',').padEnd(12)} tuile ${String(r.got).padEnd(12)} ΔE ${String(r.dE).padEnd(5)} | écran ${String(e.got).padEnd(12)} ΔE ${e.dE}`); }
}
if (process.env.JSON) (await import('node:fs')).writeFileSync(process.env.JSON, JSON.stringify(out, null, 1));
