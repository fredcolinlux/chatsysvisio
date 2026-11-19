// Rehaussement faible lumière (1.11) : réglages enregistrés, calculs de tonalité, zoom et contraintes de champ.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEnh, toneParams, grayWorld, srgbToLin, meanLuma } from '../../public/js/rehausse.js';
import { loadCam, controlsOf, hasControls, advancedFor, resetAdvanced, fmtZoom, zoomed, resizeModeFor } from '../../public/js/camera.js';

// vignette 64×36 remplie d'une couleur, avec quelques pixels « LED »
const thumb = (rgb, led = null, n = 64 * 36) => { const px = new Uint8Array(n * 4); for (let i = 0; i < n; i++) { const c = led && i % 50 === 0 ? led : rgb; px.set([...c, 255], i * 4); } return px; };

test('rehaussement : désactivé par défaut, intensité bornée, types faux ignorés', () => {
  assert.deepEqual(normalizeEnh(undefined), { on: false, k: 0.6, wb: false });
  assert.deepEqual(normalizeEnh({ on: 'oui', k: 7, wb: 1 }), { on: false, k: 1, wb: false });
  assert.deepEqual(normalizeEnh({ on: true, k: -2, wb: true }), { on: true, k: 0, wb: true });
  assert.deepEqual(normalizeEnh({ on: true, k: '0.333' }), { on: true, k: 0.33, wb: false });
  assert.deepEqual(normalizeEnh({ k: null }).k, 0.6);
  const c = loadCam(JSON.stringify({ enh: { on: true, k: 0.8 }, mirror: false, fill: true, ptz: true }));
  assert.deepEqual(c.enh, { on: true, k: 0.8, wb: false }); assert.equal(c.mirror, false); assert.equal(c.fill, true); assert.equal(c.ptz, true);
  assert.equal(loadCam('{}').mirror, true); // miroir par défaut
});

test('rehaussement : pièce sombre → gain fort, pièce claire → gain neutre', () => {
  const dark = toneParams(thumb([22, 14, 14]), 64, 36, 0.6), bright = toneParams(thumb([150, 140, 135]), 64, 36, 0.6);
  assert.ok(dark.expo > 3 && dark.expo <= dark.gmax, `gain sombre ${dark.expo}`);
  assert.equal(bright.expo, 1);
  // intensité 0 : rien
  assert.equal(toneParams(thumb([22, 14, 14]), 64, 36, 0).expo, 1);
  // plus d'intensité → plus de gain
  assert.ok(toneParams(thumb([22, 14, 14]), 64, 36, 1).expo > dark.expo);
  // point noir prudent : sous la moyenne, jamais plus de 0,012 linéaire
  assert.ok(dark.black <= dark.lavg * 0.4 + 1e-9 && dark.black <= 0.012);
  // carte locale : uniforme pour une image uniforme
  assert.equal(new Set(dark.loc).size, 1);
});

test('rehaussement : point blanc au-dessus des LED, rien ne sature brutalement', () => {
  const p = toneParams(thumb([20, 12, 12], [255, 20, 20]), 64, 36, 0.6);
  assert.ok(p.white >= 1, 'point blanc ≥ 1'); const led = 0.2126 * srgbToLin(255) + 0.7152 * srgbToLin(20) + 0.0722 * srgbToLin(20);
  assert.ok(p.white >= led * p.expo * 0.99, `les LED restent sous le point blanc (${p.white} / ${led * p.expo})`);
});

test('balance des blancs auto : limitée à ±25 %, les couleurs saturées ne comptent pas', () => {
  // dominante orangée modérée → corrigée vers le neutre, sans dépasser les bornes
  const g = grayWorld(thumb([120, 80, 60]), 64 * 36);
  assert.ok(g[0] < 1 && g[2] > 1, JSON.stringify(g));
  const lum = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2]; assert.ok(Math.abs(lum - 1) < 1e-6, 'luminance conservée');
  assert.ok(Math.max(...g) / Math.min(...g) <= 1.25 / 0.8 + 1e-9, 'écart entre couleurs borné');
  // image faite de LED saturées : aucun pixel « neutre » → pas de correction
  assert.deepEqual(grayWorld(thumb([250, 10, 10]), 64 * 36), [1, 1, 1]);
});

test('mesures : luminance moyenne', () => {
  assert.equal(Math.round(meanLuma(thumb([100, 100, 100]))), 100);
});

test('zoom : exposé s\'il existe, imposé seulement s\'il a été changé, « Champ complet » = minimum', () => {
  const caps = { zoom: { min: 100, max: 500, step: 1 } };
  assert.ok(controlsOf(caps).zoom); assert.ok(hasControls(caps));
  assert.deepEqual(advancedFor(caps, {}), []);
  assert.deepEqual(advancedFor(caps, { zoom: 9999 }), [{ zoom: 500 }]);
  assert.deepEqual(resetAdvanced(caps, { zoom: 130 }), [{ zoom: 130 }]);
  assert.equal(fmtZoom(130, caps.zoom), '×1,3');
  assert.ok(zoomed(caps, { zoom: 130 })); assert.ok(!zoomed(caps, { zoom: 100 })); assert.ok(!zoomed({}, { zoom: 3 }));
});

test('champ : mode natif du capteur préféré, jamais exigé', () => {
  assert.deepEqual(resizeModeFor(), { resizeMode: { ideal: 'none' } });
});
