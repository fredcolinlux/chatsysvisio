// Fausse caméra « pièce sombre » (1.11) : génère une vidéo y4m (I420) qui imite la scène d'un utilisateur dans le noir,
// pour le banc du rehaussement faible lumière et les tests (Chrome : --use-file-for-fake-video-capture=fichier.y4m).
//   node scripts/fausse-camera-sombre.mjs [sortie.y4m] [largeur] [hauteur] [images]
// Scène : murs presque noirs, bandeaux de LED rouges / vertes / bleues saturées (plafond et montants), écran bleu,
// étagères à peine visibles sur les côtés, visage sous-exposé éclairé en rouge-orangé, qui bouge doucement ;
// bruit de capteur à gain élevé : luminance (dépendant du signal) + chrominance en taches 2×2.
// Une « zone fixe » (carton gris sombre, à gauche) sert à mesurer le bruit temporel avant / après.
import fs from 'node:fs';
const out = process.argv[2] || '/tmp/csv-sombre-1080.y4m';
const W = +(process.argv[3] || 1920), H = +(process.argv[4] || 1080), N = +(process.argv[5] || 48), FPS = 24;
export const ZONE = { x: 0.16, y: 0.56, w: 0.07, h: 0.12 }; // carton gris fixe (fractions de l'image)

const toS = l => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055) * 255;
let seed = 20261119; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const gauss = () => { let s = 0; for (let i = 0; i < 4; i++) s += rnd(); return (s - 2) * 1.732; };
// radiance linéaire de la scène fixe (sans le visage) : calculée une fois
const bg = new Float32Array(W * H * 3);
const leds = [];
for (let i = 0; i < 24; i++) leds.push({ x: (i + 0.5) / 24, y: 0.05, c: [[1, .05, .05], [.05, 1, .1], [.08, .15, 1]][i % 3] });
for (let i = 0; i < 10; i++) leds.push({ x: 0.015, y: 0.15 + i * 0.08, c: [1, 0.06, 0.12] }, { x: 0.985, y: 0.15 + i * 0.08, c: [0.1, 0.2, 1] });
const A = W / H;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const u = x / W, v = y / H, j = (y * W + x) * 3;
  let r = 0.0025 + 0.002 * v, g = 0.0022, b = 0.004; // mur
  // lueur des LED sur le mur (somme de gaussiennes larges)
  for (const L of leds) { const dx = (u - L.x) * A, dy = v - L.y, d2 = dx * dx + dy * dy; const f = 0.012 * Math.exp(-d2 / 0.006); r += L.c[0] * f; g += L.c[1] * f; b += L.c[2] * f; }
  // LED elles-mêmes : petits points saturés
  for (const L of leds) { const dx = (u - L.x) * A, dy = v - L.y; if (dx * dx + dy * dy < 0.00004) { r = Math.max(r, L.c[0] * 0.95); g = Math.max(g, L.c[1] * 0.95); b = Math.max(b, L.c[2] * 0.95); } }
  // écran bleu (bas droite) + sa lueur
  const inScr = u > 0.70 && u < 0.93 && v > 0.62 && v < 0.86;
  if (inScr) { r = 0.03; g = 0.09; b = 0.42; } else { const dx = Math.max(0, Math.abs(u - 0.815) - 0.115) * A, dy = Math.max(0, Math.abs(v - 0.74) - 0.12), f = 0.03 * Math.exp(-(dx * dx + dy * dy) / 0.01); r += 0.1 * f; g += 0.3 * f; b += f; }
  // étagères sur les côtés (on doit les voir avec le champ complet)
  if ((u < 0.12 || u > 0.88) && (Math.abs(v - 0.35) < 0.008 || Math.abs(v - 0.6) < 0.008)) { r += 0.006; g += 0.005; b += 0.004; }
  if (u > 0.04 && u < 0.10 && v > 0.27 && v < 0.345) { r += 0.012; g += 0.004; b += 0.003; } // livres
  if (u > 0.90 && u < 0.96 && v > 0.52 && v < 0.595) { r += 0.003; g += 0.008; b += 0.006; }
  // carton gris (zone de mesure du bruit)
  if (u > ZONE.x && u < ZONE.x + ZONE.w && v > ZONE.y && v < ZONE.y + ZONE.h) { r = g = b = 0.009; }
  bg[j] = r; bg[j + 1] = g; bg[j + 2] = b;
}
const Y = new Uint8Array(W * H), U = new Uint8Array(W * H / 4), V = new Uint8Array(W * H / 4);
const rgb = new Float32Array(W * H * 3);
const fd = fs.openSync(out, 'w');
fs.writeSync(fd, `YUV4MPEG2 W${W} H${H} F${FPS}:1 Ip A1:1 C420mpeg2 XYSCSS=420MPEG2\n`);
const cn = new Float32Array((W / 2) * (H / 2) * 2);
for (let f = 0; f < N; f++) {
  const fx = 0.5 + 0.012 * Math.sin(2 * Math.PI * f / N), fy = 0.44 + 0.006 * Math.sin(4 * Math.PI * f / N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H, j = (y * W + x) * 3;
    let r = bg[j], g = bg[j + 1], b = bg[j + 2];
    // buste (t-shirt sombre)
    const bx = (u - fx) * A / 0.32, by = (v - 0.98) / 0.36;
    if (bx * bx + by * by < 1 && v > 0.66) { r = 0.004; g = 0.003; b = 0.006; }
    // visage : ellipse, ombrage, éclairé surtout par les LED rouges, un peu de bleu de l'écran côté droit
    const ex = (u - fx) * A / 0.135, ey = (v - fy) / 0.2, e2 = ex * ex + ey * ey;
    if (e2 < 1) {
      const sh = 0.55 + 0.45 * Math.sqrt(1 - e2), side = 0.6 + 0.4 * ex;
      r = 0.036 * sh; g = 0.012 * sh; b = (0.008 + 0.012 * Math.max(0, side - 0.6)) * sh;
      if (ey < -0.55) { r *= 0.25; g *= 0.25; b *= 0.25; } // cheveux
      for (const s of [-1, 1]) { const ox = ex - s * 0.38, oy = ey + 0.12; if (ox * ox * 4 + oy * oy * 16 < 0.12) { r *= 0.35; g *= 0.35; b *= 0.35; } }
      if (Math.abs(ex) < 0.28 && Math.abs(ey - 0.45) < 0.035) { r *= 0.5; g *= 0.4; b *= 0.4; } // bouche
    }
    rgb[j] = toS(r); rgb[j + 1] = toS(g); rgb[j + 2] = toS(b);
  }
  // bruit de chrominance en taches 2×2 (dématriçage des webcams)
  for (let i = 0; i < cn.length; i++) cn[i] = gauss() * 4.5;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const j = (y * W + x) * 3, s = (rgb[j] + rgb[j + 1] + rgb[j + 2]) / 3;
    const nl = gauss() * (4 + 0.035 * s), ci = ((y >> 1) * (W >> 1) + (x >> 1)) * 2;
    const R = rgb[j] + nl + cn[ci], G = rgb[j + 1] + nl - 0.5 * (cn[ci] + cn[ci + 1]), B = rgb[j + 2] + nl + cn[ci + 1];
    // BT.601 plage limitée (16–235) : c'est ainsi que Chrome interprète une fausse caméra y4m
    Y[y * W + x] = Math.max(0, Math.min(255, Math.round(16 + (0.299 * R + 0.587 * G + 0.114 * B) * 219 / 255)));
    if (!(x & 1) && !(y & 1)) {
      const k = (y >> 1) * (W >> 1) + (x >> 1);
      U[k] = Math.max(0, Math.min(255, Math.round(128 + (-0.168736 * R - 0.331264 * G + 0.5 * B) * 224 / 255)));
      V[k] = Math.max(0, Math.min(255, Math.round(128 + (0.5 * R - 0.418688 * G - 0.081312 * B) * 224 / 255)));
    }
  }
  fs.writeSync(fd, 'FRAME\n'); fs.writeSync(fd, Y); fs.writeSync(fd, U); fs.writeSync(fd, V);
}
fs.closeSync(fd);
console.log(`${out} : ${W}×${H}, ${N} images à ${FPS} i/s`);
