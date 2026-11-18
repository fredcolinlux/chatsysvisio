// Réglages de la caméra (1.10) et débit HD selon la taille du salon.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCam, pick, frameRateFor, clampCap, controlsOf, hasControls, advancedFor, resetAdvanced, fmtExposure } from '../../public/js/camera.js';
import { hdKbps, hdParams, normalizeRate } from '../../public/js/quality.js';

// Capacités typiques d'une Logitech C920 sous Chrome / Windows
const C920 = { brightness: { min: 0, max: 255, step: 1 }, contrast: { min: 0, max: 255, step: 1 }, saturation: { min: 0, max: 255, step: 1 }, sharpness: { min: 0, max: 255, step: 1 },
  exposureMode: ['manual', 'continuous'], exposureTime: { min: 1, max: 2047, step: 1 }, whiteBalanceMode: ['manual', 'continuous'], colorTemperature: { min: 2000, max: 6500, step: 10 } };

test('caméra : lecture robuste du stockage (JSON cassé, clés inconnues, types faux)', () => {
  assert.deepEqual(loadCam('{pas du json'), { lowLight: false, rate: 'auto', dev: {} });
  const c = loadCam(JSON.stringify({ lowLight: true, rate: 'high', dev: { a: { set: { brightness: 120, evil: '<script>', exposureMode: 'x', sharpness: '9' }, def: { brightness: 128 } } } }));
  assert.equal(c.lowLight, true); assert.equal(c.rate, 'high');
  assert.deepEqual(c.dev.a.set, { brightness: 120 }); assert.deepEqual(c.dev.a.def, { brightness: 128 });
  assert.equal(loadCam(JSON.stringify({ rate: 'turbo' })).rate, 'auto');
  assert.deepEqual(pick({ whiteBalanceMode: 'manual', colorTemperature: 4500, zoom: 3 }), { whiteBalanceMode: 'manual', colorTemperature: 4500 });
});

test('caméra : cadence normale et faible lumière', () => {
  assert.deepEqual(frameRateFor({ lowLight: false }), { ideal: 24, max: 30 });
  assert.deepEqual(frameRateFor({ lowLight: true }), { ideal: 15, max: 15 });
});

test('caméra : bornes et pas', () => {
  assert.equal(clampCap({ min: 0, max: 255, step: 1 }, 300), 255);
  assert.equal(clampCap({ min: 2000, max: 6500, step: 10 }, 4504), 4500);
  assert.equal(clampCap(undefined, 3), null);
});

test('caméra : seuls les réglages modifiés sont imposés, un groupe par réglage', () => {
  assert.ok(hasControls(C920)); assert.ok(!hasControls({ width: { min: 1, max: 1920 } }));
  assert.equal(controlsOf(C920).sliders.length, 4);
  assert.deepEqual(advancedFor(C920, {}), []);
  assert.deepEqual(advancedFor(C920, { brightness: 140.4, exposureMode: 'manual', exposureTime: 333 }), [{ exposureMode: 'manual', exposureTime: 333 }, { brightness: 140 }]);
  assert.deepEqual(advancedFor(C920, { whiteBalanceMode: 'continuous', colorTemperature: 3000 }), [{ whiteBalanceMode: 'continuous' }]);
  // caméra sans contrôle (Firefox, Safari) : rien n'est envoyé
  assert.deepEqual(advancedFor({}, { brightness: 10, exposureMode: 'manual' }), []);
});

test('caméra : réinitialisation vers les valeurs d\'origine', () => {
  const r = resetAdvanced(C920, { brightness: 128, sharpness: 128, exposureMode: 'continuous', whiteBalanceMode: 'continuous' });
  assert.deepEqual(r, [{ exposureMode: 'continuous' }, { whiteBalanceMode: 'continuous' }, { brightness: 128 }, { sharpness: 128 }]);
});

test('caméra : affichage du temps d\'exposition (unités de 100 µs)', () => {
  assert.equal(fmtExposure(333), '33 ms · 1/30 s');
  assert.equal(fmtExposure(5), '0,5 ms');
});

test('débit HD : élevé en petit salon, dégressif ensuite, réglage Standard / Élevé', () => {
  assert.equal(hdKbps(2500, 4000), 2500); // sans taille de salon : comportement d'avant
  assert.equal(hdKbps(2500, 4000, { n: 2 }), 4000);
  assert.equal(hdKbps(2500, 4000, { n: 3 }), 4000);
  assert.equal(hdKbps(2500, 4000, { n: 5 }), 3250);
  assert.equal(hdKbps(2500, 4000, { n: 12 }), 2500);
  assert.equal(hdKbps(2500, 4000, { n: 2, rate: 'std' }), 2500);
  assert.equal(hdKbps(2500, 4000, { n: 25, rate: 'high' }), 4000);
  assert.equal(hdKbps(2500, 1000, { n: 2 }), 2500); // plafond mal réglé (< plancher) : jamais sous le plancher
  assert.equal(hdParams(1080, { hd1080: 2500, hd1080max: 4000 }, { n: 2 }).kbps, 4000);
  assert.equal(hdParams(720, { hd720: 1200, hd720max: 2000 }, { n: 2 }).kbps, 2000);
  assert.equal(normalizeRate('x'), 'auto');
});
