import { test } from '@playwright/test';
import { createRoom } from './helpers.mjs';
// Captures du panneau « Réglages de la caméra » (SHOTS=1). Capacités simulées d'une Logitech C920 sous Chrome / Windows.
test.skip(!process.env.SHOTS, 'captures : SHOTS=1');
function c920() {
  const P = MediaStreamTrack.prototype, gc = P.getCapabilities, gs = P.getSettings;
  const caps = { brightness: { min: 0, max: 255, step: 1 }, contrast: { min: 0, max: 255, step: 1 }, saturation: { min: 0, max: 255, step: 1 }, sharpness: { min: 0, max: 255, step: 1 },
    exposureMode: ['manual', 'continuous'], exposureTime: { min: 3, max: 2047, step: 1 }, exposureCompensation: undefined, whiteBalanceMode: ['manual', 'continuous'], colorTemperature: { min: 2000, max: 6500, step: 10 } };
  const cur = { brightness: 128, contrast: 128, saturation: 128, sharpness: 128, exposureMode: 'continuous', exposureTime: 333, whiteBalanceMode: 'continuous', colorTemperature: 4000 };
  P.getCapabilities = function () { const c = gc.call(this); return this.kind === 'video' ? { ...c, ...caps } : c; };
  P.getSettings = function () { const s = gs.call(this); return this.kind === 'video' ? { ...s, ...cur } : s; };
  Object.defineProperty(P, 'label', { get() { return this.kind === 'video' ? 'HD Pro Webcam C920' : 'Micro'; } });
}
for (const [name, vp] of [['camera-reglages', { viewport: { width: 1440, height: 900 } }], ['camera-reglages-mobile', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }], ['camera-reglages-sombre', { viewport: { width: 1440, height: 900 }, colorScheme: 'dark' }]]) {
  test(name, async ({ browser }) => {
    const ctx = await browser.newContext(vp); const page = await ctx.newPage();
    await page.addInitScript(c920);
    const url = await createRoom(page, 'Réglages caméra');
    await page.goto(url); await page.waitForTimeout(1500);
    await page.evaluate(() => localStorage.setItem('cc-quality', '1080p'));
    await page.click('.camopen'); await page.waitForTimeout(300);
    await page.locator('.modal input.camr[data-k="sharpness"]').fill('96');
    await page.locator('.modal .cammode[data-k="whiteBalanceMode"] button[data-m="manual"]').click();
    await page.locator('.modal input.camr[data-k="colorTemperature"]').fill('4500');
    await page.locator('.modal .camlow').click();
    await page.waitForTimeout(600);
    await page.mouse.move(5, 5); await page.evaluate(() => { document.activeElement?.blur(); document.querySelector('.modal').scrollTop = 0; }); await page.waitForTimeout(200);
    await page.screenshot({ path: `/workspace/${name}.png` });
    await ctx.close();
  });
}
