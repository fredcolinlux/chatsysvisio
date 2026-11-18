// Qualité vidéo d'envoi : réglage (Auto / 360p / 720p / 1080p / Économie), plafond selon l'appareil,
// choix de la couche à recevoir, adaptation automatique (1080p → 720p → 360p) et repli côté relais.
// Module pur (sans DOM) : partagé par le navigateur, le serveur et les tests unitaires.
import { L_LO, L_HI, L_HD } from './protocol.js';

export const QUALITY_OPTIONS = [
  ['auto', 'Auto', 'Auto : 1080p sur ordinateur, 720p sur mobile, selon la caméra et le réseau'],
  ['360p', '360p', '360p : léger, idéal en 4G'],
  ['720p', '720p', '720p HD'],
  ['1080p', '1080p', '1080p Full HD (~2,5 Mbit/s, seulement quand on t\'affiche en grand)'],
  ['eco', 'Éco', 'Économie : vignette basse définition seulement'],
];
const VALID = new Set(QUALITY_OPTIONS.map(o => o[0]));
export const HEIGHTS = [144, 360, 720, 1080];

// Valeur mémorisée → réglage valide (l'ancien « hd » de la 1.0 devient « 720p »).
export function normalizeQuality(v) { if (v === 'hd') return '720p'; return VALID.has(v) ? v : 'auto'; }

// Plafond voulu (hauteur, côté court) avant de regarder la caméra réelle.
//   env : { mobile, effects, codec, deviceMax (1080/720/360, d'après VideoEncoder.isConfigSupported), serverMax }
export function ceilingFor(q, env = {}) {
  q = normalizeQuality(q);
  if (q === 'eco') return 144;
  let h = q === '360p' ? 360 : q === '720p' ? 720 : q === '1080p' ? 1080 : (env.mobile ? 720 : 1080);
  if (env.codec === 'jpeg') h = Math.min(h, 360);                       // JPEG en 720p/1080p : beaucoup trop lourd
  if (env.mobile && env.effects) h = Math.min(h, 720);                  // flou/fond sur mobile : 720p max (CPU, chauffe)
  h = Math.min(h, env.deviceMax ?? 1080, env.serverMax ?? 1080);
  return HEIGHTS.filter(x => x <= h).at(-1) || 144;
}

// Hauteur réellement possible avec la source (caméra ou image composée) : côté court de l'image.
export function clampToSource(h, sw, sh) {
  const short = Math.min(sw || 0, sh || 0); if (!short) return h;
  for (const x of [1080, 720, 360]) if (x <= h && short >= x * 0.95) return x;
  return Math.min(h, 360);
}

// Débit de la couche HD (1.10) : à 2,5 Mbit/s, une image 1080p de webcam (grain du capteur compris) devient pâteuse ;
// en petit salon on monte au plafond (4 Mbit/s par défaut), puis on redescend vers le plancher quand le salon grandit
// (chaque personne reçoit jusqu'à 4 couches HD). Réglage « Débit HD » : auto (selon le nombre de personnes),
// std (plancher, comportement d'avant la 1.10) ou high (plafond, quel que soit le nombre de personnes).
//   n : personnes dans le salon (soi compris) ; base / max : plancher / plafond en kbit/s.
export const RATE_OPTIONS = [
  ['auto', 'Auto', 'Auto : débit élevé à 2 ou 3, réduit quand le salon grandit'],
  ['std', 'Standard', 'Standard : débit d\'avant la 1.10, plus léger pour le réseau'],
  ['high', 'Élevé', 'Élevé : débit maximal, image la plus nette (réseau plus sollicité)'],
];
export const normalizeRate = v => RATE_OPTIONS.some(o => o[0] === v) ? v : 'auto';
export function hdKbps(base, max, { n = 0, rate = 'auto' } = {}) {
  max = Math.max(base, max || base); rate = normalizeRate(rate);
  if (rate === 'std' || !n && rate === 'auto') return base;
  if (rate === 'high' || n <= 3) return max;
  if (n <= 6) return Math.round((base + max) / 2 / 50) * 50;
  return base;
}

// Paramètres d'encodage de la couche HD (L_HD) selon la hauteur visée (o : { n, rate } pour le débit, voir hdKbps).
export function hdParams(h, br = {}, o = {}) {
  if (h >= 1080) return { maxW: 1920, maxH: 1080, kbps: hdKbps(br.hd1080 || 2500, br.hd1080max, o), fps: 24, quality: 0.75 };
  if (h >= 720) return { maxW: 1280, maxH: 720, kbps: hdKbps(br.hd720 || 1200, br.hd720max, o), fps: 24, quality: 0.72 };
  return { maxW: 640, maxH: 360, kbps: br.hi || 450, fps: 15, quality: 0.62 };
}

// Partage d'écran : 1080p (texte net) sauf réglage 360p/720p/Éco, codec JPEG ou adaptation en cours.
export function screenParams(q, { codec, adaptLevel = 0, serverMax = 1080 } = {}, br = {}) {
  q = normalizeQuality(q);
  const full = codec !== 'jpeg' && adaptLevel === 0 && serverMax >= 1080 && (q === 'auto' || q === '1080p');
  return full ? { maxW: 1920, maxH: 1080, kbps: br.screenHd || 1500, fps: 6, quality: 0.75 }
    : { maxW: 1280, maxH: 720, kbps: br.screen || 900, fps: 6, quality: 0.7 };
}

// Couche à demander pour une tuile.
//   big : la tuile est affichée en grand (épinglée/plein écran, ≤ 4 tuiles, orateur sur ordinateur)
//   w, h : taille affichée (px CSS), dpr : densité d'écran, vq : hauteur max annoncée par l'émetteur
//   noHd : HD refusée localement (décodeur en retard, connexion dégradée)
export function pickLayer({ big, w = 0, h = 0, dpr = 1, vq = 360, noHd = false }) {
  if (!big || vq <= 144) return L_LO;
  const need = Math.max(w * 9 / 16, h) * Math.min(dpr || 1, 2); // hauteur vidéo affichée (object-fit: cover)
  return !noHd && vq > 360 && need > 480 ? L_HD : L_HI;
}

// Adaptation côté émetteur : redescend 1080p → 720p → 360p si la socket accumule (bufferedAmount)
// ou si l'encodeur prend du retard ; remonte d'un cran après 20 s sans alerte.
export class SendAdapter {
  constructor({ downAfter = 1000, upAfter = 20000, highWater = 250_000 } = {}) {
    Object.assign(this, { downAfter, upAfter, highWater }); this.level = 0; this.badSince = null; this.lastChange = 0;
  }
  // Renvoie la hauteur effective (≤ ceiling).
  update({ ceiling, buffered = 0, lagging = false, now }) {
    const ladder = [1080, 720, 360].filter(x => x <= ceiling);
    if (!ladder.length) return ceiling;
    this.level = Math.min(this.level, ladder.length - 1);
    const bad = buffered > this.highWater || lagging;
    if (bad) {
      this.badSince ??= now;
      if (now - this.badSince >= this.downAfter && this.level < ladder.length - 1) { this.level++; this.badSince = now; this.lastChange = now; }
    } else {
      this.badSince = null;
      if (this.level > 0 && now - this.lastChange >= this.upAfter) { this.level--; this.lastChange = now; }
    }
    return ladder[this.level];
  }
}

// Repli côté relais pour un destinataire saturé : niveau 1 = chaque couche caméra descend d'un cran
// (HD → 360p, 360p → vignette), niveau 2 = vignettes seulement. Le partage d'écran n'est jamais remplacé.
export function degradeLayer(layer, level) {
  if (!level) return layer;
  if (layer === L_HD) return level >= 2 ? L_LO : L_HI;
  if (layer === L_HI) return L_LO;
  return layer;
}
