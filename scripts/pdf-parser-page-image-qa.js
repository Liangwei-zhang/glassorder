#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parsePdf } = require('../backend/services/pdfParser');

const candidates = [
  '/mnt/c/Users/nico_/Downloads/Glass Order - 260612 Acme - 135.pdf',
  path.join(__dirname, '..', 'Glass Order - 260612 Acme - 135.pdf'),
];
const pdf = candidates.find((file) => fs.existsSync(file));
if (!pdf) {
  throw new Error(`sample PDF missing. Checked: ${candidates.join(', ')}`);
}

const outputDir = '/tmp/glassorder-parser-page-image-qa';
fs.rmSync(outputDir, { recursive: true, force: true });
const parsed = parsePdf(pdf, { outputDir, publicBase: '/uploads/parser-page-image-qa' });

if (parsed.total !== 9 || parsed.pieces.length !== 9) {
  throw new Error(`expected 9 parsed pieces, got total=${parsed.total} pieces=${parsed.pieces.length}`);
}
for (let n = 1; n <= 9; n += 1) {
  const file = path.join(outputDir, `piece${n}.jpg`);
  if (!fs.existsSync(file)) throw new Error(`missing copied piece image ${file}`);
  if (fs.statSync(file).size < 1000) throw new Error(`piece image too small ${file}`);
}
if (!fs.existsSync(path.join(outputDir, 'page-02.jpg'))) {
  throw new Error('expected pdftocairo zero-padded page image page-02.jpg for regression coverage');
}

console.log(`PDF PARSER PAGE IMAGE QA PASS pieces=${parsed.pieces.length}`);
