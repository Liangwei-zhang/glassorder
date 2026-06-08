#!/usr/bin/env node
/* Generate PWA icons (192/512 + maskable 512) from an inline SVG. */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let sharp;
const candidates = [
  path.join(__dirname, '..', 'backend', 'node_modules', 'sharp'),
  path.join(__dirname, '..', '..', 'node_modules', 'sharp'),
  path.join(__dirname, '..', '..', '..', 'node_modules', 'sharp'),
];
for (const c of candidates) {
  try { sharp = require(c); break; } catch (e) { /* try next */ }
}
if (!sharp) {
  try { sharp = require('sharp'); } catch (e) {
    // install on demand into the workspace root
    console.error('sharp not found; install it via `npm install --no-save sharp` first');
    process.exit(1);
  }
}

const ICONS_DIR = path.join(__dirname, '..', 'frontend', 'icons');
fs.mkdirSync(ICONS_DIR, { recursive: true });

function logoSvg(size, { maskable = false } = {}) {
  const radius = maskable ? 0 : Math.round(size * 0.22);
  const margin = maskable ? size * 0.11 : size * 0.08;
  const paneX = margin;
  const paneY = size * 0.18;
  const paneW = size - margin * 2;
  const paneH = size * 0.58;
  const paneR = size * 0.055;
  const line = Math.max(4, size * 0.018);
  const fontSize = size * 0.29;
  const subFont = size * 0.067;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${radius}" fill="#111827"/>
  <path d="M0 ${size * 0.72} C ${size * 0.22} ${size * 0.58}, ${size * 0.78} ${size * 0.90}, ${size} ${size * 0.68} L ${size} ${size} L 0 ${size} Z" fill="#0f766e" opacity=".72"/>
  <rect x="${paneX}" y="${paneY}" width="${paneW}" height="${paneH}" rx="${paneR}" fill="#f8fafc"/>
  <rect x="${paneX + line * 1.6}" y="${paneY + line * 1.6}" width="${paneW - line * 3.2}" height="${paneH - line * 3.2}" rx="${paneR * 0.65}" fill="#dff7fb"/>
  <path d="M${paneX + paneW * 0.16} ${paneY + paneH * 0.16} L${paneX + paneW * 0.64} ${paneY + paneH * 0.16} L${paneX + paneW * 0.30} ${paneY + paneH * 0.54} L${paneX + paneW * 0.72} ${paneY + paneH * 0.54}" fill="none" stroke="#ffffff" stroke-width="${line}" stroke-linecap="round" opacity=".76"/>
  <path d="M${paneX + paneW * 0.16} ${paneY + paneH * 0.74} H${paneX + paneW * 0.84}" stroke="#14b8a6" stroke-width="${line * 0.95}" stroke-linecap="round"/>
  <text x="${size / 2}" y="${paneY + paneH * 0.58}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="900" letter-spacing="0" fill="#111827">GO</text>
  <text x="${size / 2}" y="${size * 0.88}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${subFont}" font-weight="800" letter-spacing="0" fill="#f8fafc">GLASS ORDER</text>
</svg>`;
}

(async () => {
  for (const [name, svg] of [
    ['icon-192.png', logoSvg(192)],
    ['icon-512.png', logoSvg(512)],
    ['icon-maskable-512.png', logoSvg(512, { maskable: true })],
  ]) {
    const out = path.join(ICONS_DIR, name);
    await sharp(Buffer.from(svg)).png().toFile(out);
    console.log('  wrote', out);
  }
  // Apple touch icon (180x180)
  const apple = path.join(ICONS_DIR, 'apple-touch-icon.png');
  await sharp(Buffer.from(logoSvg(180))).png().toFile(apple);
  console.log('  wrote', apple);
})().catch((err) => { console.error(err); process.exit(1); });
