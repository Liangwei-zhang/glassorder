#!/usr/bin/env node
const {
  extractPoCodeFromFilename,
  normalizePoCode,
  poCodeKey,
  poLookupKeys,
} = require('../backend/services/poCode');

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const parseCases = [
  ['Glass Order - 260514 Glass Built- PO 546.pdf', 'PO 546'],
  ['Glass Order - 260513 You -Canmore (1).pdf', 'Canmore (1)'],
  ['Glass Order - 260515 Kinspace 10698.pdf', '10698'],
  ['Glass Order - 260515 Kinspace 10695.pdf', '10695'],
  ['Glass Order - 260515 Acme- 328.pdf', '328'],
  ['Glass Order - 260512 Sohal Glass Jackso.pdf', 'Jackso'],
  ['Glass Order - 260620 PO Upload QA PO POU-123.pdf', 'PO POU-123'],
  ['  glass order - 260514 Glass Built - p.o. # 546.pdf  ', 'PO 546'],
  ['Glass Order \u2013 260515 Acme \u2013 328.pdf', '328'],
  ['Glass Order - 260513 You - Canmore (1).PDF', 'Canmore (1)'],
  ['Glass Order - 260620 Portal Job 332.pdf', '332'],
  ['invoice-260515-Kinspace-10698.pdf', ''],
  ['Glass Order - Kinspace 10698.pdf', ''],
];

for (const [filename, expected] of parseCases) {
  expectEqual(extractPoCodeFromFilename(filename), expected, filename);
}

expectEqual(normalizePoCode('po-546'), 'PO 546', 'normalize hyphen PO');
expectEqual(normalizePoCode(' P.O. # 546 '), 'PO 546', 'normalize dotted PO');
expectEqual(normalizePoCode('POU-123'), 'POU-123', 'do not treat POU as PO');
expectEqual(normalizePoCode('PO POU-123'), 'PO POU-123', 'preserve explicit PO value');
expectEqual(poCodeKey('PO 546'), poCodeKey('po-546'), 'PO key ignores punctuation/case');
expectEqual(poCodeKey('Canmore (1)'), poCodeKey('canmore-1'), 'PO key ignores brackets/hyphen');

const lookup546 = poLookupKeys('546');
if (!lookup546.includes(poCodeKey('PO 546')) || !lookup546.includes(poCodeKey('546'))) {
  throw new Error(`lookup keys should include bare and PO forms: ${JSON.stringify(lookup546)}`);
}
const lookupPo546 = poLookupKeys('PO 546');
if (!lookupPo546.includes(poCodeKey('PO 546')) || !lookupPo546.includes(poCodeKey('546'))) {
  throw new Error(`PO lookup keys should include bare form: ${JSON.stringify(lookupPo546)}`);
}

console.log(`PO CODE PARSE QA PASS cases=${parseCases.length}`);
