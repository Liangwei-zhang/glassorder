const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function run(command, args) {
  return execFileSync(command, args, {
    encoding: command === 'pdftotext' ? 'utf8' : 'buffer',
    maxBuffer: 20 * 1024 * 1024,
  });
}

function cleanLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeDimension(value) {
  const text = String(value || '').trim().replace(/[″“”]/g, '"');
  return text.endsWith('"') ? text : `${text}"`;
}

function parseCover(text) {
  const lines = cleanLines(text);
  const totalMatch = text.match(/Total\s+of\s+(\d+)\s+Panel\(s\)\s+in\s+this\s+Order/i);
  const projectMatch = text.match(/Project\s+Name:\s*(.+)/i);
  const projectName = projectMatch ? projectMatch[1].trim() : null;
  const orderNumberMatch = projectName ? projectName.match(/\b(\d{6,})\b/) : null;

  return {
    total: totalMatch ? Number(totalMatch[1]) : null,
    projectName,
    orderNumber: orderNumberMatch ? orderNumberMatch[1] : null,
    location: locationFromLines(lines),
  };
}

function locationFromLines(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^Location:\s*(.*)$/i);
    if (!match) continue;
    const inline = match[1].trim();
    if (inline) return inline;
    for (let j = i + 1; j < Math.min(lines.length, i + 4); j += 1) {
      const candidate = lines[j].trim();
      if (!candidate) continue;
      if (/^(Project #:?|Supplier:|Address:|Total (Area|Weight):|Page \d+)/i.test(candidate)) break;
      return candidate;
    }
  }
  return '';
}

function marksFromLines(lines) {
  const line = lines.find((value) => /^Marks?:\s*/i.test(value));
  if (!line) return '';
  return line.replace(/^Marks?:\s*/i, '').trim();
}

function noteFromLines(lines, sizeLineIndex) {
  const ignored = [
    /^Measurements are in inches$/i,
    /^\d+\s+ea$/i,
    /^Printed On:/i,
    /^Project #:?$/i,
    /^Location:/i,
    /^Supplier:/i,
    /^Address:/i,
    /^Total (Area|Weight):/i,
    /^As per attached drawings$/i,
    /^Templates For Glass Cut-Outs$/i,
    /^Template [A-Z]:/i,
    /^\d+\s*x\s+.*Surcharge$/i,
    /^\d+\s*x\s+Complex$/i,
    /^\d+\s*x\s+Flat Polish$/i,
    /^0%\s+price$/i,
    /^[\d\s/.-]+"?\s*\([^)]+\)$/i,
    /^Sunshine Tempered Glass Ltd$/i,
    /^Page \d+ of \d+$/i,
  ];

  const notes = [];
  for (let i = sizeLineIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (ignored.some((regex) => regex.test(line))) continue;
    if (/^(FP|SE)$/i.test(line)) continue;
    if (/^[\d\s/.-]+$/.test(line)) continue;
    if (/^[Øø]\s*\d/i.test(line)) continue;
    if (/^[A-Z]{2,}\d+$/i.test(line)) continue;
    notes.push(line);
  }
  return [...new Set(notes)].join(' · ');
}

function parsePiecePage(pageText, pageNumber, defaultLocation = '') {
  const lines = cleanLines(pageText);
  const qtyIndex = lines.findIndex((line) => /^(\d+)\s+ea$/i.test(line));
  const qty = qtyIndex >= 0 ? Number(lines[qtyIndex].match(/^(\d+)\s+ea$/i)[1]) : 1;
  const materialLine = lines.find((line) => /^([\d.]+mm)\s+(.+)$/i.test(line));
  if (!materialLine) return null;
  const materialMatch = materialLine.match(/^([\d.]+mm)\s+(.+)$/i);
  if (!materialMatch) return null;

  const sizeLineIndex = lines.findIndex((line) => /"\s*[x×]\s*.+\([\d.]+lb\)/i.test(line));
  if (sizeLineIndex < 0) return null;

  const sizeMatch = lines[sizeLineIndex].match(/([0-9][0-9./ -]*")\s*[x×]\s*([0-9][0-9./ -]*")\s*\(([\d.]+lb)\)/i);
  if (!sizeMatch) return null;

  return {
    qty,
    pageNumber,
    thickness: materialMatch[1],
    type: materialMatch[2].trim(),
    size: `${normalizeDimension(sizeMatch[1])} × ${normalizeDimension(sizeMatch[2])}`,
    weight: sizeMatch[3],
    tag: locationFromLines(lines) || marksFromLines(lines) || defaultLocation,
    piece_note: noteFromLines(lines, sizeLineIndex),
  };
}

function convertPages(pdfPath, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  run('pdftocairo', ['-jpeg', '-r', '144', pdfPath, path.join(outputDir, 'page')]);
}

function convertedPageImage(outputDir, pageNumber) {
  const candidates = [
    `page-${pageNumber}.jpg`,
    `page-${String(pageNumber).padStart(2, '0')}.jpg`,
    `page-${String(pageNumber).padStart(3, '0')}.jpg`,
    `page-${String(pageNumber).padStart(4, '0')}.jpg`,
  ];
  for (const filename of candidates) {
    const file = path.join(outputDir, filename);
    if (fs.existsSync(file)) return file;
  }
  const prefix = `page-${pageNumber}`;
  const found = fs.readdirSync(outputDir)
    .find((name) => name === `${prefix}.jpg` || name.match(new RegExp(`^page-0+${pageNumber}\\.jpg$`)));
  return found ? path.join(outputDir, found) : '';
}

function publicPath(publicBase, filename) {
  if (!publicBase) return filename;
  return `${publicBase.replace(/\/$/, '')}/${filename}`;
}

function addBlockPieces({ pieces, block, outputDir, publicBase, usePageImage }) {
  const pageImage = usePageImage ? convertedPageImage(outputDir, block.pageNumber) : '';
  for (let copy = 0; copy < block.qty; copy += 1) {
    const pieceNo = pieces.length + 1;
    const pieceImageName = `piece${pieceNo}.jpg`;
    const pieceImage = path.join(outputDir, pieceImageName);
    let drawingPath = '';
    if (pageImage && fs.existsSync(pageImage)) {
      fs.copyFileSync(pageImage, pieceImage);
      drawingPath = publicPath(publicBase, pieceImageName);
    }
    pieces.push({
      piece_no: pieceNo,
      stage: 'cut',
      hold: false,
      rework: false,
      broken: false,
      size: block.size,
      type: block.type,
      thickness: block.thickness,
      weight: block.weight,
      tag: block.tag,
      piece_note: block.piece_note,
      drawing_path: drawingPath,
      source_page: block.pageNumber,
    });
  }
}

function parsePdf(pdfPath, options = {}) {
  const outputDir = options.outputDir || path.join(path.dirname(pdfPath), 'parsed');
  const publicBase = options.publicBase || '';
  const text = run('pdftotext', [pdfPath, '-']);
  const pages = text.split('\f');
  const cover = parseCover(pages[0] || text);

  convertPages(pdfPath, outputDir);

  const pieces = [];
  for (let pageIndex = 1; pageIndex < pages.length; pageIndex += 1) {
    const pageNumber = pageIndex + 1;
    const block = parsePiecePage(pages[pageIndex], pageNumber, cover.location);
    if (!block) continue;

    addBlockPieces({ pieces, block, outputDir, publicBase, usePageImage: true });
  }

  if (!pieces.length) {
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const pageNumber = pageIndex + 1;
      const block = parsePiecePage(pages[pageIndex], pageNumber, cover.location);
      if (!block) continue;

      addBlockPieces({ pieces, block, outputDir, publicBase, usePageImage: false });
    }
  }

  return {
    total: cover.total || pieces.length,
    pieces,
    coverPage: publicPath(publicBase, 'page-1.jpg'),
    projectName: cover.projectName,
    orderNumber: cover.orderNumber,
    text,
  };
}

function extractPieceTagsFromPdf(pdfPath) {
  const text = run('pdftotext', [pdfPath, '-']);
  const pages = text.split('\f');
  const cover = parseCover(pages[0] || text);
  const tags = [];
  for (let pageIndex = 1; pageIndex < pages.length; pageIndex += 1) {
    const block = parsePiecePage(pages[pageIndex], pageIndex + 1, cover.location);
    if (!block) continue;
    for (let copy = 0; copy < block.qty; copy += 1) {
      tags.push(block.tag || cover.location || '');
    }
  }
  return tags;
}

module.exports = { parsePdf, extractPieceTagsFromPdf };
