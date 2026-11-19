// Réglages de la caméra (1.10) : contrôles que le navigateur expose (Image Capture : getCapabilities / applyConstraints),
// mode « faible lumière » et débit HD. Enregistrés dans ce navigateur (localStorage « csv-cam »), par caméra.
// Module sans DOM : partagé par la page d'appel et les tests unitaires.
//
// Principe : on n'impose QUE ce que la personne a changé. Une valeur jamais touchée reste celle du pilote — y compris
// celle qu'un logiciel du fabricant (Logi Tune, G HUB…) a pu laisser dans la caméra. Les valeurs d'origine sont
// relevées à la première ouverture de chaque caméra pour pouvoir « Réinitialiser ».
import { normalizeRate } from './quality.js';
import { normalizeEnh } from './rehausse.js';

export const CAM_KEY = 'csv-cam';
export const SLIDERS = [
  ['brightness', 'Luminosité'], ['contrast', 'Contraste'], ['saturation', 'Saturation'], ['sharpness', 'Netteté'],
];
const KEYS = ['brightness', 'contrast', 'saturation', 'sharpness', 'exposureMode', 'exposureTime', 'exposureCompensation', 'whiteBalanceMode', 'colorTemperature', 'zoom'];

export function loadCam(raw = (typeof localStorage !== 'undefined' ? localStorage.getItem(CAM_KEY) : null)) {
  let o = {}; try { o = JSON.parse(raw || '{}') || {}; } catch {}
  const dev = {};
  if (o.dev && typeof o.dev === 'object') for (const [id, d] of Object.entries(o.dev).slice(0, 8)) {
    if (typeof id !== 'string' || id.length > 200 || !d || typeof d !== 'object') continue;
    dev[id] = { set: pick(d.set), def: pick(d.def) };
  }
  // 1.11 : rehaussement faible lumière (désactivé par défaut), aperçu de soi en miroir (oui par défaut) et en champ
  // complet (oui par défaut : l'image entière, sans rogner les bords), zoom demandé à la caméra (autorisation « PTZ »).
  return { lowLight: o.lowLight === true, rate: normalizeRate(o.rate), dev, enh: normalizeEnh(o.enh), mirror: o.mirror !== false, fill: o.fill === true, ptz: o.ptz === true };
}
export function saveCam(c) { try { localStorage.setItem(CAM_KEY, JSON.stringify(c)); } catch {} }

// Ne garde que des clés connues, avec des valeurs du bon type.
export function pick(o) {
  const r = {}; if (!o || typeof o !== 'object') return r;
  for (const k of KEYS) {
    const v = o[k];
    if (/Mode$/.test(k)) { if (v === 'manual' || v === 'continuous') r[k] = v; }
    else if (typeof v === 'number' && Number.isFinite(v)) r[k] = v;
  }
  return r;
}

// Cadence demandée à la caméra. En faible lumière, 15 i/s laissent à l'exposition automatique jusqu'à 66 ms par image
// (au lieu de 33–41 ms) : moins de gain, donc moins de grain. Les logiciels des fabricants font pareil (RightLight).
export const frameRateFor = c => c?.lowLight ? { ideal: 15, max: 15 } : { ideal: 24, max: 30 };

// Valeur ramenée dans la plage et sur le pas annoncés par la caméra.
export function clampCap(cap, v) {
  if (!cap || typeof cap.min !== 'number' || typeof cap.max !== 'number' || !Number.isFinite(+v)) return null;
  let x = Math.min(cap.max, Math.max(cap.min, +v));
  if (cap.step > 0) x = Math.min(cap.max, cap.min + Math.round((x - cap.min) / cap.step) * cap.step);
  return +x.toFixed(4);
}
const ranged = cap => !!cap && typeof cap.min === 'number' && cap.max > cap.min;

// Contrôles réellement réglables sur cette caméra (d'après getCapabilities).
export function controlsOf(caps = {}) {
  return {
    sliders: SLIDERS.filter(([k]) => ranged(caps[k])).map(([k, label]) => ({ k, label, cap: caps[k] })),
    exposure: Array.isArray(caps.exposureMode) && caps.exposureMode.includes('manual') && caps.exposureMode.includes('continuous') && ranged(caps.exposureTime),
    exposureComp: ranged(caps.exposureCompensation),
    zoom: ranged(caps.zoom),
    wb: Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('manual') && caps.whiteBalanceMode.includes('continuous') && ranged(caps.colorTemperature),
  };
}
export const hasControls = caps => { const c = controlsOf(caps || {}); return c.sliders.length > 0 || c.exposure || c.exposureComp || c.wb || c.zoom; };

// Contraintes « advanced » : un groupe par réglage (un refus n'empêche pas les autres), seulement ce qui a été changé.
export function advancedFor(caps = {}, set = {}) {
  const c = controlsOf(caps), adv = [];
  if (c.exposure && set.exposureMode) {
    const o = { exposureMode: set.exposureMode };
    if (set.exposureMode === 'manual' && set.exposureTime != null) o.exposureTime = clampCap(caps.exposureTime, set.exposureTime);
    adv.push(o);
  }
  if (c.exposureComp && set.exposureCompensation != null && set.exposureMode !== 'manual') adv.push({ exposureCompensation: clampCap(caps.exposureCompensation, set.exposureCompensation) });
  if (c.wb && set.whiteBalanceMode) {
    const o = { whiteBalanceMode: set.whiteBalanceMode };
    if (set.whiteBalanceMode === 'manual' && set.colorTemperature != null) o.colorTemperature = clampCap(caps.colorTemperature, set.colorTemperature);
    adv.push(o);
  }
  for (const { k, cap } of c.sliders) if (set[k] != null) adv.push({ [k]: clampCap(cap, set[k]) });
  if (c.zoom && set.zoom != null) adv.push({ zoom: clampCap(caps.zoom, set.zoom) });
  return adv;
}

// Valeurs d'origine (relevées avant toute modification) à réappliquer pour « Réinitialiser ».
export function resetAdvanced(caps = {}, def = {}) {
  const c = controlsOf(caps), adv = [];
  if (c.exposure) adv.push(def.exposureMode === 'manual' && def.exposureTime != null ? { exposureMode: 'manual', exposureTime: clampCap(caps.exposureTime, def.exposureTime) } : { exposureMode: 'continuous' });
  if (c.exposureComp && def.exposureCompensation != null) adv.push({ exposureCompensation: clampCap(caps.exposureCompensation, def.exposureCompensation) });
  if (c.wb) adv.push(def.whiteBalanceMode === 'manual' && def.colorTemperature != null ? { whiteBalanceMode: 'manual', colorTemperature: clampCap(caps.colorTemperature, def.colorTemperature) } : { whiteBalanceMode: 'continuous' });
  for (const { k, cap } of c.sliders) if (def[k] != null) adv.push({ [k]: clampCap(cap, def[k]) });
  if (c.zoom && def.zoom != null) adv.push({ zoom: clampCap(caps.zoom, def.zoom) });
  return adv;
}

// Zoom : « ×1,3 » ; un zoom au-dessus du minimum recadre l'image (champ réduit).
export const fmtZoom = (v, cap) => '×' + (cap?.min > 0 ? v / cap.min : v).toLocaleString('fr-FR', { maximumFractionDigits: 2 });
export const zoomed = (caps = {}, st = {}) => ranged(caps.zoom) && typeof st.zoom === 'number' && st.zoom > caps.zoom.min + (caps.zoom.step || 0) / 2;

// Contrainte de base demandée à la caméra (ouverture et réglage à chaud).
// resizeMode « none » en préférence (pas exigé) : on veut un mode natif du capteur, pas une image recadrée et
// redimensionnée par le navigateur pour coller exactement à la taille demandée (Chrome : « crop-and-scale » par défaut).
// Si aucun mode natif ne convient (ex. pas de 15 i/s natif en faible lumière), le navigateur revient au recadrage.
export const resizeModeFor = () => ({ resizeMode: { ideal: 'none' } });

// exposureTime est exprimé en centaines de microsecondes (spécification Image Capture).
export function fmtExposure(v) {
  const ms = v / 10;
  return ms >= 1000 ? `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s` : ms >= 10 ? `${Math.round(ms)} ms · 1/${Math.round(1000 / ms)} s` : `${ms.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ms`;
}
