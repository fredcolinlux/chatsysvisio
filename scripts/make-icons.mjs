#!/usr/bin/env node
// Génère le favicon et les icônes PWA (style « bleu calme » : carré bleu plein, caméra blanche au trait).
// Usage : node scripts/make-icons.mjs   (Chrome via Playwright, aucun accès réseau)
import { chromium } from '@playwright/test';
import { writeFileSync } from 'node:fs';

const BLUE = '#2f6fe4';
const CAM = '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3"/>';
// size : côté ; radius : arrondi (0 = plein cadre) ; glyph : part du côté occupée par la caméra ; stroke : épaisseur
function svg({ size, radius, glyph, stroke }) {
  const g = size * glyph, off = (size - g) / 2, k = g / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<rect width="${size}" height="${size}" rx="${size * radius}" fill="${BLUE}"/>
${radius ? `<rect x=".5" y=".5" width="${size - 1}" height="${size - 1}" rx="${size * radius}" fill="none" stroke="rgba(255,255,255,.12)" stroke-width="1"/>` : ''}
<g transform="translate(${off} ${off + g * 0.01}) scale(${k})" fill="none" stroke="#fff" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">${CAM}</g></svg>`;
}
const jobs = [
  ['public/icons/icon-512.png', { size: 512, radius: 0.225, glyph: 0.58, stroke: 1.7 }],
  ['public/icons/icon-192.png', { size: 192, radius: 0.225, glyph: 0.58, stroke: 1.8 }],
  ['public/icons/maskable-512.png', { size: 512, radius: 0, glyph: 0.46, stroke: 1.8 }],   // zone sûre : cercle de 80 %
  ['public/icons/apple-touch-icon.png', { size: 180, radius: 0, glyph: 0.56, stroke: 1.8 }], // iOS arrondit lui-même
];
const ico = [16, 32, 48].map(s => [s, { size: s, radius: 0.22, glyph: 0.78, stroke: s <= 16 ? 2.6 : 2.2 }]);

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome' });
const page = await browser.newPage({ deviceScaleFactor: 1 });
async function render(o) {
  await page.setViewportSize({ width: o.size, height: o.size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg(o)}</body></html>`);
  return page.locator('svg').screenshot({ omitBackground: true });
}
for (const [file, o] of jobs) { writeFileSync(file, await render(o)); console.log('✔', file); }
// favicon.ico : conteneur ICO avec des images PNG (16, 32, 48)
const pngs = [];
for (const [s, o] of ico) pngs.push([s, await render(o)]);
const head = Buffer.alloc(6 + 16 * pngs.length);
head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
let offset = head.length;
pngs.forEach(([s, buf], i) => {
  const e = 6 + 16 * i;
  head.writeUInt8(s % 256, e); head.writeUInt8(s % 256, e + 1); head.writeUInt8(0, e + 2); head.writeUInt8(0, e + 3);
  head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6); head.writeUInt32LE(buf.length, e + 8); head.writeUInt32LE(offset, e + 12);
  offset += buf.length;
});
writeFileSync('public/favicon.ico', Buffer.concat([head, ...pngs.map(p => p[1])]));
console.log('✔ public/favicon.ico');
await browser.close();
