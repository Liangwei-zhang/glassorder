const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

let sharp = null;
try {
  sharp = require('sharp');
} catch (err) {
  sharp = null;
}

const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const WORKFLOW_CODES = {
  cut: 'CCUT01',
  edge: 'CFAB1',
  tempered: 'CTMP1',
  polish: 'CPOLISH',
  finished: 'CFIN',
};
const SHAPE_PREVIEW_VERSION = 'v2';

function poLabel(value) {
  const code = String(value || '').trim();
  if (!code) return 'PO -';
  return /^PO\b/i.test(code) ? code : `PO ${code}`;
}

function cleanText(value, fallback = '') {
  return String(value || fallback || '').replace(/\s+/g, ' ').trim();
}

function compactText(value, limit) {
  const text = cleanText(value);
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 3))}...`;
}

function safeBarcodeText(value) {
  return cleanText(value, 'GLASSORDER')
    .toUpperCase()
    .replace(/[^A-Z0-9 ._$%/+:-]/g, '-')
    .slice(0, 48) || 'GLASSORDER';
}

function parseSteps(piece) {
  if (Array.isArray(piece.required_steps) && piece.required_steps.length) return piece.required_steps;
  try {
    const parsed = JSON.parse(piece.process_config || '{}');
    if (Array.isArray(parsed.required_steps) && parsed.required_steps.length) return parsed.required_steps;
  } catch (err) {
    /* ignore malformed legacy config */
  }
  return ['cut', 'edge', 'tempered'];
}

function workflowCodes(piece) {
  const seen = new Set();
  const codes = [];
  for (const step of parseSteps(piece)) {
    const code = WORKFLOW_CODES[step];
    if (code && !seen.has(code)) {
      seen.add(code);
      codes.push(code);
    }
  }
  for (const code of ['CPACKING', 'CSHIPPING']) {
    if (!seen.has(code)) codes.push(code);
  }
  return codes;
}

function parseInches(value) {
  const text = cleanText(value)
    .replace(/["”]/g, '')
    .replace(/-/g, ' ');
  let total = 0;
  let matched = false;
  for (const part of text.split(/\s+/).filter(Boolean)) {
    const fraction = part.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
    if (fraction) {
      const n = Number(fraction[1]);
      const d = Number(fraction[2]);
      if (Number.isFinite(n) && Number.isFinite(d) && d) {
        total += n / d;
        matched = true;
      }
      continue;
    }
    const n = Number(part);
    if (Number.isFinite(n)) {
      total += n;
      matched = true;
    }
  }
  return matched ? total : null;
}

function metricSize(size) {
  const parts = cleanText(size).split(/\s*[x×]\s*/i);
  if (parts.length !== 2) return '';
  const a = parseInches(parts[0]);
  const b = parseInches(parts[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
  return `${Math.round(a * 25.4)}mm x ${Math.round(b * 25.4)}mm`;
}

function weightText(weight) {
  const text = cleanText(weight);
  if (!text) return '-- LBS';
  return text
    .replace(/\blbs?\b/ig, 'LBS')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function uploadPathToFile(publicPath, uploadsBase) {
  const text = String(publicPath || '');
  if (!text.startsWith('/uploads/')) return '';
  const rel = text.replace(/^\/uploads\//, '').replace(/\\/g, '/');
  const target = path.resolve(uploadsBase, rel);
  const root = path.resolve(uploadsBase);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return '';
  return target;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function expandBounds(bounds, width, height) {
  const marginX = Math.max(4, Math.round((bounds.right - bounds.left + 1) * 0.06));
  const marginY = Math.max(4, Math.round((bounds.bottom - bounds.top + 1) * 0.04));
  return {
    left: clamp(bounds.left - marginX, 0, width - 1),
    top: clamp(bounds.top - marginY, 0, height - 1),
    right: clamp(bounds.right + marginX, 0, width - 1),
    bottom: clamp(bounds.bottom + marginY, 0, height - 1),
  };
}

function findShapeBoundsFromRaw(data, width, height) {
  const minX = Math.floor(width * 0.08);
  const maxX = Math.ceil(width * 0.92);
  const minY = Math.floor(height * 0.16);
  const maxY = Math.ceil(height * 0.93);
  const visited = new Uint8Array(width * height);
  const isDark = (idx) => data[idx] < 220;
  let best = null;
  let fallback = null;

  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const start = (y * width) + x;
      if (visited[start] || !isDark(start)) continue;

      const stack = [start];
      visited[start] = 1;
      let count = 0;
      let left = x;
      let right = x;
      let top = y;
      let bottom = y;

      while (stack.length) {
        const idx = stack.pop();
        count += 1;
        const cx = idx % width;
        const cy = Math.floor(idx / width);
        if (cx < left) left = cx;
        if (cx > right) right = cx;
        if (cy < top) top = cy;
        if (cy > bottom) bottom = cy;

        for (let ny = cy - 1; ny <= cy + 1; ny += 1) {
          if (ny < minY || ny >= maxY) continue;
          for (let nx = cx - 1; nx <= cx + 1; nx += 1) {
            if (nx < minX || nx >= maxX || (nx === cx && ny === cy)) continue;
            const nidx = (ny * width) + nx;
            if (!visited[nidx] && isDark(nidx)) {
              visited[nidx] = 1;
              stack.push(nidx);
            }
          }
        }
      }

      if (count < 16) continue;
      const boxWidth = right - left + 1;
      const boxHeight = bottom - top + 1;
      const component = { left, right, top, bottom, count, score: (boxWidth * boxHeight) + (count * 8) };
      if (!fallback) fallback = { left, right, top, bottom };
      else {
        fallback.left = Math.min(fallback.left, left);
        fallback.right = Math.max(fallback.right, right);
        fallback.top = Math.min(fallback.top, top);
        fallback.bottom = Math.max(fallback.bottom, bottom);
      }
      if (boxWidth > width * 0.12 && boxHeight > height * 0.18 && count > 80) {
        if (!best || component.score > best.score) best = component;
      }
    }
  }

  const bounds = best || fallback;
  if (!bounds) return null;
  return expandBounds(bounds, width, height);
}

async function createShapePreview(sourceFile, uploadsBase) {
  if (!sharp || !sourceFile || !fs.existsSync(sourceFile)) return '';
  const stat = fs.statSync(sourceFile);
  const hash = crypto.createHash('sha1')
    .update(SHAPE_PREVIEW_VERSION)
    .update(path.resolve(sourceFile))
    .update(String(stat.size))
    .update(String(stat.mtimeMs))
    .digest('hex')
    .slice(0, 20);
  const previewDir = path.join(uploadsBase, 'labels', 'shape-previews');
  const outputPath = path.join(previewDir, `shape-${hash}.png`);
  if (fs.existsSync(outputPath)) return outputPath;

  try {
    fs.mkdirSync(previewDir, { recursive: true });
    const source = sharp(sourceFile).rotate();
    const metadata = await source.metadata();
    if (!metadata.width || !metadata.height) return '';
    const analysisWidth = Math.min(metadata.width, 820);
    const { data, info } = await source
      .clone()
      .resize({ width: analysisWidth, withoutEnlargement: true })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const bounds = findShapeBoundsFromRaw(data, info.width, info.height);
    if (!bounds) return '';
    const scaleX = metadata.width / info.width;
    const scaleY = metadata.height / info.height;
    const crop = {
      left: clamp(Math.floor(bounds.left * scaleX), 0, metadata.width - 1),
      top: clamp(Math.floor(bounds.top * scaleY), 0, metadata.height - 1),
      width: clamp(Math.ceil((bounds.right - bounds.left + 1) * scaleX), 1, metadata.width),
      height: clamp(Math.ceil((bounds.bottom - bounds.top + 1) * scaleY), 1, metadata.height),
    };
    crop.width = Math.min(crop.width, metadata.width - crop.left);
    crop.height = Math.min(crop.height, metadata.height - crop.top);
    if (crop.width < 24 || crop.height < 24) return '';
    await sharp(sourceFile)
      .rotate()
      .extract(crop)
      .resize({
        width: 180,
        height: 300,
        fit: 'contain',
        background: '#ffffff',
        withoutEnlargement: false,
      })
      .png()
      .toFile(outputPath);
    return outputPath;
  } catch (err) {
    return '';
  }
}

async function preparePieceLabelData(piece, uploadsBase) {
  const sourceFile = uploadPathToFile(piece.drawing_path, uploadsBase);
  const shapePreviewPath = await createShapePreview(sourceFile, uploadsBase);
  return {
    ...piece,
    label_shape_preview_path: shapePreviewPath,
  };
}

function code128Values(text) {
  const safe = safeBarcodeText(text);
  const values = [104];
  for (const ch of safe) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 127) values.push(13);
    else values.push(code - 32);
  }
  let checksum = values[0];
  for (let i = 1; i < values.length; i += 1) checksum += values[i] * i;
  values.push(checksum % 103);
  values.push(106);
  return values;
}

function drawCode128(doc, text, x, y, width, height) {
  const values = code128Values(text);
  const modules = values.reduce((sum, value) => (
    sum + CODE128_PATTERNS[value].split('').reduce((n, digit) => n + Number(digit), 0)
  ), 0);
  const moduleWidth = width / modules;
  let cursor = x;
  doc.save().fillColor('black');
  for (const value of values) {
    const pattern = CODE128_PATTERNS[value];
    for (let i = 0; i < pattern.length; i += 1) {
      const w = Number(pattern[i]) * moduleWidth;
      if (i % 2 === 0) doc.rect(cursor, y, w, height).fill();
      cursor += w;
    }
  }
  doc.restore();
}

function line(doc, x1, y1, x2, y2, width = 0.8) {
  doc.save().lineWidth(width).strokeColor('#111').moveTo(x1, y1).lineTo(x2, y2).stroke().restore();
}

function drawFabFlag(doc, x, y) {
  doc.save();
  doc.lineWidth(0.7).strokeColor('#111').moveTo(x, y).lineTo(x, y + 30).stroke();
  doc
    .fillColor('#111')
    .polygon([x + 1, y + 1], [x + 13, y + 7], [x + 1, y + 13])
    .fill();
  doc.restore();
}

function drawFitText(doc, text, x, y, options) {
  const max = options.max || 32;
  const min = options.min || 8;
  const width = options.width;
  const height = options.height;
  for (let size = max; size >= min; size -= 1) {
    doc.fontSize(size);
    if (doc.heightOfString(text, { width }) <= height) {
      doc.text(text, x, y, { width, height, ellipsis: true });
      return;
    }
  }
  doc.fontSize(min).text(text, x, y, { width, height, ellipsis: true });
}

function drawSingleLineFit(doc, text, x, y, options) {
  const max = options.max || 12;
  const min = options.min || 6;
  const width = options.width;
  const height = options.height || max + 3;
  let chosen = min;
  for (let size = max; size >= min; size -= 0.5) {
    doc.fontSize(size);
    if (doc.widthOfString(text) <= width) {
      chosen = size;
      break;
    }
  }
  doc.save();
  doc.rect(x, y - 1, width, height).clip();
  doc.fontSize(chosen).text(text, x, y, { lineBreak: false });
  doc.restore();
}

function drawPieceLabel(doc, { order, piece, uploadsBase }) {
  const left = 13;
  const top = 10;
  const right = 272;
  const rightX = 210;
  const labelCode = safeBarcodeText(`GO-${order.id}-${piece.id}-${piece.piece_no}`);
  const orderCode = cleanText(order.order_number);
  const orderDisplay = compactText(orderCode, 18);
  const shipDate = cleanText(order.deadline) || cleanText(order.created_at).slice(0, 10) || '-';
  const route = order.priority === 'rush' ? 'RUSH' : 'STANDARD';
  const size = cleanText(piece.size, '-');
  const metric = metricSize(size);
  const glassType = cleanText(piece.type, 'GLASS');
  const thickness = cleanText(piece.thickness);
  const note = cleanText(piece.piece_note);
  const shape = piece.drawing_path ? 'LIBRARY' : 'STANDARD';

  doc.save();
  doc.rect(0, 0, 288, 432).fill('#fff');
  doc.fillColor('#111').font('Helvetica');

  drawSingleLineFit(doc.font('Helvetica'), `ORDER: ${orderDisplay || '-'}-${piece.piece_no}`, left, top, { width: 96, max: 9.5, min: 5.5 });
  drawSingleLineFit(doc.font('Helvetica-Bold'), `PO: ${orderDisplay || '-'}`, 116, top - 1, { width: 86, max: 12, min: 5.5 });
  drawSingleLineFit(doc.font('Helvetica'), `SHIP: ${shipDate}`, 210, top, { width: 62, max: 9.5, min: 5.5 });
  drawSingleLineFit(doc.font('Helvetica'), `ROUTE:${route}`, left, 29, { width: 110, max: 9.5, min: 5.5 });
  drawSingleLineFit(doc.font('Helvetica'), `REF:P${piece.piece_no} ${orderDisplay || '-'}`, 116, 29, { width: 122, max: 9.5, min: 5.5 });

  drawFitText(doc.font('Helvetica-Bold'), cleanText(order.company, 'CUSTOMER').toUpperCase(), left, 52, {
    width: 184,
    height: 34,
    max: 23,
    min: 13,
  });
  line(doc, left, 88, 205, 88, 1.1);

  drawSingleLineFit(doc.font('Helvetica'), cleanText(thickness ? `${thickness} ${glassType}` : glassType).toUpperCase(), left, 94, { width: 108, height: 10, max: 8.8, min: 5.8 });
  doc.font('Helvetica').fontSize(9).text('SHAPE:', 126, 94, { width: 34, lineBreak: false });
  doc.save();
  doc.rect(161, 90, 62, 15).fill('#111');
  drawSingleLineFit(doc.fillColor('#fff').font('Helvetica-Bold'), shape, 165, 94, { width: 54, height: 8, max: 8.5, min: 6 });
  doc.restore();
  doc.fillColor('#111').font('Helvetica-Bold');

  doc.fontSize(32).text(String(piece.piece_no || ''), left, 122, { width: 42, height: 36 });
  drawFitText(doc, size, 56, 124, { width: 138, height: 36, max: 24, min: 12 });
  doc.font('Helvetica').fontSize(11).text(metric || ' ', left, 166, { width: 120 });
  doc.font('Helvetica').fontSize(16).text('Glaze In', 136, 154, { width: 72, align: 'center', lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(8).text('>>', left, 184, { width: 24, lineBreak: false });

  doc.font('Helvetica').fontSize(8.4).text(note || 'No special fabrication notes.', left, 198, {
    width: 178,
    height: 76,
    ellipsis: true,
    lineGap: 1.1,
  });

  const previewFile = uploadPathToFile(piece.drawing_path, uploadsBase);
  const shapePreviewFile = piece.label_shape_preview_path || '';
  doc.save();
  if (shapePreviewFile && fs.existsSync(shapePreviewFile)) {
    try {
      doc.image(shapePreviewFile, 224, 56, { fit: [44, 86], align: 'center', valign: 'center' });
    } catch (err) {
      doc.fontSize(5.5).fillColor('#777').text('DRAWING', 230, 102, { width: 30, align: 'center' });
    }
  } else if (previewFile && fs.existsSync(previewFile)) {
    try {
      doc.image(previewFile, 224, 56, { fit: [44, 86], align: 'center', valign: 'center' });
    } catch (err) {
      doc.fontSize(5.5).fillColor('#777').text('DRAWING', 230, 102, { width: 30, align: 'center' });
    }
  } else {
    doc.fontSize(5.5).fillColor('#777').text('DRAWING', 230, 102, { width: 30, align: 'center' });
  }
  doc.restore();

  doc.font('Helvetica').fontSize(10.5).text('WEIGHT', rightX, 154, { width: 62, align: 'right' });
  line(doc, rightX, 170, right, 170, 1.1);
  drawFitText(doc.font('Helvetica-Bold'), weightText(piece.weight), rightX - 2, 178, { width: 64, height: 22, max: 15, min: 9 });
  line(doc, rightX, 205, right, 205, 1.1);
  drawSingleLineFit(doc.font('Helvetica'), 'WORKFLOW', rightX - 5, 219, { width: 67, height: 14, max: 11.5, min: 8 });
  line(doc, rightX, 236, right, 236, 1.1);
  doc.font('Helvetica-Bold').fontSize(10.8);
  workflowCodes(piece).forEach((code, index) => {
    doc.text(code, rightX - 1, 247 + (index * 14), { width: 63, align: 'right', lineBreak: false });
  });

  doc.font('Helvetica').fontSize(6.8).text(`TM/CNC:${labelCode}`, left, 292, { width: 176, lineBreak: false });
  doc.font('Helvetica').fontSize(8.5).text(`SHIP: ${shipDate}`, left, 314, { width: 96 });
  drawSingleLineFit(doc.font('Helvetica-Bold'), `CUT: ${compactText(orderCode || '-', 15) || '-'} / ${piece.piece_no}`, left, 338, { width: 118, height: 20, max: 16, min: 8 });
  drawFabFlag(doc, 142, 309);
  doc.font('Helvetica').fontSize(11).text('FAB', 145, 338, { width: 34 });
  doc.fontSize(7.4).text('RACK/SLOT', 182, 343, { width: 42, lineBreak: false });
  line(doc, 225, 349, right, 349, 1.1);

  drawCode128(doc, labelCode, 96, 372, 146, 34);
  drawSingleLineFit(doc.font('Helvetica'), `PO: ${orderCode || '-'}`, left, 411, { width: 78, height: 8, max: 5.2, min: 4 });
  doc.font('Helvetica-Bold').fontSize(9.5).text(`SUMP: ${labelCode}`, 91, 409, { width: 160, align: 'center' });
  doc.restore();
}

async function createPieceLabelsPdf({ order, pieces, outputPath, uploadsBase }) {
  const preparedPieces = [];
  for (const piece of pieces) {
    preparedPieces.push(await preparePieceLabelData(piece, uploadsBase));
  }

  const doc = new PDFDocument({ size: [288, 432], margin: 0, autoFirstPage: false });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  for (const piece of preparedPieces) {
    doc.addPage({ size: [288, 432], margin: 0 });
    drawPieceLabel(doc, { order, piece, uploadsBase });
  }

  doc.end();
  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

module.exports = {
  createPieceLabelsPdf,
  metricSize,
  safeBarcodeText,
  workflowCodes,
};
