#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const PDFDocument = require('../backend/node_modules/pdfkit');
const { parsePdf } = require('../backend/services/pdfParser');

const outputPdf = path.join('/tmp', `glassorder-single-page-template-${Date.now()}.pdf`);
const outputDir = path.join('/tmp', `glassorder-single-page-template-parsed-${Date.now()}`);

function createTemplatePdf(file) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
    const stream = fs.createWriteStream(file);
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.on('error', reject);
    doc.pipe(stream);
    [
      'Sunshine Tempered Glass Ltd',
      '4435 90 Ave SE',
      'Calgary AB T2C 2S6',
      '',
      'GLASS ORDER',
      '',
      'Supplier: Sunshine Tempered Glass',
      'Address: 4435 90 Ave SE',
      'Calgary AB T2C 2S6',
      'Total of 1 Panel(s) in this Order',
      'Measurements are in inches',
      '',
      '1 ea',
      '',
      'Printed On: 6/18/2026',
      'Project Name: 260618 A1 Closets - Pardeep template',
      'Project #:',
      '',
      'Total Area: 18.75sq ft',
      'Total Weight: 61.5lb',
      '',
      '6mm Clear Tempered',
      '90" x 30" (61.5lb)',
      'Flat Polish 2 Long 2 Short',
      'Tempered logo',
      'See separate template for shape/cutout details',
      'Marks: P1',
      '1 x Energy Surcharge',
      '0% price',
      '240 x Flat Polish',
      '240" (2L 2S)',
      '1 x Complex',
      '1 x Template Surcharge',
      '',
      'Sunshine Tempered Glass Ltd',
      'Page 1 of 1',
    ].forEach((line) => doc.text(line));
    doc.end();
  });
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

(async () => {
  await createTemplatePdf(outputPdf);
  fs.rmSync(outputDir, { recursive: true, force: true });
  const parsed = parsePdf(outputPdf, {
    outputDir,
    publicBase: '/uploads/single-page-template-qa',
  });
  assertEqual(parsed.total, 1, 'total');
  assertEqual(parsed.projectName, '260618 A1 Closets - Pardeep template', 'projectName');
  assertEqual(parsed.pieces.length, 1, 'piece count');

  const piece = parsed.pieces[0];
  assertEqual(piece.piece_no, 1, 'piece_no');
  assertEqual(piece.size, '90" × 30"', 'size');
  assertEqual(piece.type, 'Clear Tempered', 'type');
  assertEqual(piece.thickness, '6mm', 'thickness');
  assertEqual(piece.weight, '61.5lb', 'weight');
  assertEqual(piece.tag, 'P1', 'tag');
  assertEqual(piece.drawing_path, '', 'drawing_path');
  if (!piece.piece_note.includes('Flat Polish 2 Long 2 Short')
    || !piece.piece_note.includes('Tempered logo')
    || !piece.piece_note.includes('See separate template for shape/cutout details')
    || !piece.piece_note.includes('Marks: P1')) {
    throw new Error(`piece_note missing expected content: ${piece.piece_note}`);
  }
  if (/Surcharge|0% price|240 x Flat Polish|Complex/.test(piece.piece_note)) {
    throw new Error(`piece_note included pricing/surcharge lines: ${piece.piece_note}`);
  }
  if (fs.existsSync(path.join(outputDir, 'piece1.jpg'))) {
    throw new Error('single-page template should not create a piece drawing image');
  }
  if (!fs.existsSync(path.join(outputDir, 'page-1.jpg'))) {
    throw new Error('expected converted cover/page image to exist');
  }

  console.log('PDF PARSER SINGLE PAGE TEMPLATE QA PASS');
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
