const path = require('path');

const DASHES = /[\u2010-\u2015\u2212]/g;

function normalizeText(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(DASHES, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimCode(value) {
  return normalizeText(value)
    .replace(/^[\s#._:-]+/, '')
    .replace(/[\s#._:-]+$/, '')
    .trim();
}

function normalizePoCode(value) {
  const text = trimCode(value);
  if (!text) return '';
  const explicit = text.match(/^P\.?\s*O\.?(?=\s|[-#:._]|\d|$)\s*[-#:._]*\s*(.+)$/i);
  if (explicit) {
    const code = trimCode(explicit[1]);
    return code ? `PO ${code}` : '';
  }
  return text;
}

function poCodeKey(value) {
  return normalizePoCode(value)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function poLookupKeys(value) {
  const normalized = normalizePoCode(value);
  const keys = [];
  const add = (key) => {
    if (key && !keys.includes(key)) keys.push(key);
  };
  add(poCodeKey(normalized));
  if (normalized && !/^PO\b/i.test(normalized)) {
    add(poCodeKey(`PO ${normalized}`));
  } else {
    const explicit = normalized.match(/^PO\s+(.+)$/i);
    if (explicit) add(poCodeKey(explicit[1]));
  }
  return keys;
}

function stemFromFilename(originalName) {
  const filename = path.basename(String(originalName || '').trim());
  if (!filename) return '';
  return filename.replace(/\.pdf$/i, '');
}

function explicitPoFromTail(text) {
  const marker = /(?:^|[\s-])P\.?\s*O\.?(?=\s|[-#:._]|\d|$)\s*[-#:._]*\s*/gi;
  let match;
  let last = null;
  while ((match = marker.exec(text)) !== null) {
    last = match;
  }
  if (!last) return '';
  return trimCode(text.slice(last.index + last[0].length));
}

function candidateFromTail(title) {
  const text = trimCode(title);
  if (!text) return '';

  const explicit = explicitPoFromTail(text);
  if (explicit) return normalizePoCode(`PO ${explicit}`);

  const tailNumber = text.match(/(?:^|[\s_-])(\d+)\s*$/);
  if (tailNumber) return normalizePoCode(tailNumber[1]);

  const dashParts = text.split(/\s*-+\s*/).map(trimCode).filter(Boolean);
  if (dashParts.length > 1) return normalizePoCode(dashParts[dashParts.length - 1]);

  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const last = words[words.length - 1];
  if (/^\([^)]+\)$/.test(last) && words.length > 1) {
    return normalizePoCode(`${words[words.length - 2]} ${last}`);
  }
  return normalizePoCode(last);
}

function extractPoCodeFromFilename(originalName) {
  const stem = normalizeText(stemFromFilename(originalName));
  if (!stem) return '';

  const prefix = stem.match(/^glass\s*order\s*[-:]*\s*(.+)$/i);
  if (!prefix) return '';

  const afterPrefix = trimCode(prefix[1]);
  const date = afterPrefix.match(/^(\d{6,8})\b\s*(.+)$/);
  if (!date) return '';

  const candidate = candidateFromTail(date[2]);
  const key = poCodeKey(candidate);
  return key ? candidate : '';
}

module.exports = {
  extractPoCodeFromFilename,
  poLookupKeys,
  normalizePoCode,
  poCodeKey,
};
