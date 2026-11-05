import { test, expect } from '@playwright/test';
import { createRoom, joinRoom, withQuery } from './helpers.mjs';
import { BARS, BOTTOM, mireInit, sampleTile, report } from './mire.mjs';

// Fidélité des couleurs : une mire connue traverse émetteur → serveur → récepteur ; écart ΔE (CIE76) toléré.
// 1.5.1 : VP8 ne transporte pas son espace colorimétrique ; sans l'indication de l'émetteur, noirs 16→0, blancs 191→204, jaune décalé (ΔE ≈ 6 à 14).
const CASES = [
  { name: 'VP8 (canvas RGB)', force: '' },
  { name: 'H.264', force: '?force=avc' },
  { name: 'JPEG', force: '?force=jpeg' },
  { name: 'VP8, caméra YUV plage pleine BT.601', force: '', yuv: { matrix: 'smpte170m', fullRange: true }, size: [640, 360], quality: '360p' },
];
for (const c of CASES) {
  test(`couleurs fidèles : ${c.name}`, async ({ browser }) => {
    const ca = await browser.newContext(), cb = await browser.newContext();
    await ca.addInitScript(mireInit, { bars: BARS, bottom: BOTTOM, yuv: c.yuv || null, size: c.size || [1280, 720] });
    const a = await ca.newPage(), b = await cb.newPage();
    const url = await createRoom(a, 'Mire');
    if (c.quality) await a.evaluate(q => localStorage.setItem('cc-quality', q), c.quality);
    await a.goto(withQuery(url, c.force)); await joinRoom(a, a.url(), 'Mire');
    await b.goto(withQuery(url, c.force)); await joinRoom(b, b.url(), 'Regard');
    await b.waitForFunction(() => Object.values(window.__cc?.decoded?.video || {}).some(n => n > 30), null, { timeout: 40_000 });
    await expect.poll(async () => { const s = await sampleTile(b); return s ? report(s).meanDE : 99; }, { timeout: 15_000, intervals: [1000] }).toBeLessThan(2.5);
    const r = report(await sampleTile(b));
    expect(r.maxDE, JSON.stringify(r.rows)).toBeLessThan(6);
    expect(r.chromaRatio).toBeGreaterThan(0.93); expect(r.chromaRatio).toBeLessThan(1.07); // ni terne ni sursaturé
    await ca.close(); await cb.close();
  });
}
