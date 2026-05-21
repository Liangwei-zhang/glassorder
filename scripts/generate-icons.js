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

// Brand-aligned: dark factory glyph on warm white. Stripe-like.
const baseSvg = (size, padding) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * 0.22}" fill="#18181b"/>
  <g transform="translate(${size / 2}, ${size / 2}) scale(${(size - padding * 2) / 24})" stroke="#fafaf9" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(-12, -12)">
      <path d="M2 20V8l6 4V8l6 4V8l6 4v8z" fill="rgba(250,250,249,.06)"/>
      <path d="M2 20V8l6 4V8l6 4V8l6 4v8z"/>
      <path d="M2 20h20"/>
    </g>
  </g>
</svg>`;

// Maskable: solid background tile with safe zone
const maskableSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="#18181b"/>
  <g transform="translate(${size / 2}, ${size / 2}) scale(${size / 36})" stroke="#fafaf9" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <g transform="translate(-12, -12)">
      <path d="M2 20V8l6 4V8l6 4V8l6 4v8z"/>
      <path d="M2 20h20"/>
    </g>
  </g>
</svg>`;

(async () => {
  for (const [name, svg] of [
    ['icon-192.png', baseSvg(192, 28)],
    ['icon-512.png', baseSvg(512, 72)],
    ['icon-maskable-512.png', maskableSvg(512)],
  ]) {
    const out = path.join(ICONS_DIR, name);
    await sharp(Buffer.from(svg)).png().toFile(out);
    console.log('  wrote', out);
  }
  // Apple touch icon (180x180)
  const apple = path.join(ICONS_DIR, 'apple-touch-icon.png');
  await sharp(Buffer.from(baseSvg(180, 26))).png().toFile(apple);
  console.log('  wrote', apple);
})().catch((err) => { console.error(err); process.exit(1); });
