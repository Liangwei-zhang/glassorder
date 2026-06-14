#!/usr/bin/env node
/* Generate PWA icons from the official logo image. */
const fs = require('fs');
const path = require('path');

let sharp;
const candidates = [
  path.join(__dirname, '..', 'backend', 'node_modules', 'sharp'),
  path.join(__dirname, '..', '..', 'node_modules', 'sharp'),
  path.join(__dirname, '..', '..', '..', 'node_modules', 'sharp'),
];
for (const c of candidates) {
  try {
    sharp = require(c);
    break;
  } catch (e) {
    /* try next */
  }
}
if (!sharp) {
  try {
    sharp = require('sharp');
  } catch (e) {
    console.error('sharp not found; install it via `npm install --no-save sharp` first');
    process.exit(1);
  }
}

const ICONS_DIR = path.join(__dirname, '..', 'frontend', 'icons');
const SOURCE_LOGO = path.join(ICONS_DIR, 'logo.jpg');
const BG = { r: 250, g: 250, b: 249, alpha: 1 };

if (!fs.existsSync(SOURCE_LOGO)) {
  console.error(`Missing official logo source: ${SOURCE_LOGO}`);
  process.exit(1);
}

fs.mkdirSync(ICONS_DIR, { recursive: true });

async function makeIcon(name, size, { paddingRatio = 0.06 } = {}) {
  const padding = Math.max(0, Math.round(size * paddingRatio));
  const contentSize = Math.max(1, size - padding * 2);
  const logo = await sharp(SOURCE_LOGO)
    .rotate()
    .resize({
      width: contentSize,
      height: contentSize,
      fit: 'contain',
      background: BG,
      withoutEnlargement: false,
    })
    .png()
    .toBuffer();

  const out = path.join(ICONS_DIR, name);
  await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: BG,
    },
  })
    .composite([{ input: logo, gravity: 'center' }])
    .png()
    .toFile(out);
  console.log('  wrote', out);
}

(async () => {
  await makeIcon('favicon-32.png', 32, { paddingRatio: 0 });
  await makeIcon('apple-touch-icon.png', 180, { paddingRatio: 0.05 });
  await makeIcon('icon-192.png', 192, { paddingRatio: 0.05 });
  await makeIcon('icon-512.png', 512, { paddingRatio: 0.05 });
  await makeIcon('icon-maskable-512.png', 512, { paddingRatio: 0.18 });
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
