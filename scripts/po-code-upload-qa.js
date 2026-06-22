#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:8781';
const ROOT = path.join(__dirname, '..');
const SAMPLE_PDF = path.join(ROOT, 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');

async function raw(apiPath, opts = {}) {
  const res = await fetch(BASE + apiPath, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    data = text;
  }
  return { status: res.status, data };
}

async function api(apiPath, opts = {}) {
  const res = await raw(apiPath, opts);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${apiPath} ${res.status}: ${JSON.stringify(res.data)}`);
  }
  return res.data;
}

function auth(session) {
  return { Authorization: `Bearer ${session.token}` };
}

function pdfBuffer(label) {
  return Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% po upload qa ${label}\n`),
  ]);
}

async function upload(session, customerId, fileBytes, filename) {
  const form = new FormData();
  form.set('customer_id', String(customerId));
  form.set('priority', 'normal');
  form.set('deadline', '2026-06-30');
  form.set('note', 'po upload qa');
  form.set('pdf', new File([fileBytes], filename, { type: 'application/pdf' }));
  return raw('/api/orders', {
    method: 'POST',
    headers: auth(session),
    body: form,
  });
}

function expectStatus(res, status, label) {
  if (res.status !== status) {
    throw new Error(`${label}: expected ${status}, got ${res.status}: ${JSON.stringify(res.data)}`);
  }
}

(async () => {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const session = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'admin123' }),
  });

  const customerRes = await api('/api/customers', {
    method: 'POST',
    headers: { ...auth(session), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      company: `PO Upload QA ${stamp}`,
      contact_name: 'QA',
      email: `po-upload-${stamp}@example.test`,
    }),
  });
  const customerId = customerRes.customer.id;
  const po = `PO POU-${stamp}`;
  const filename = `Glass Order - 260620 PO Upload QA ${po}.pdf`;

  const created = await upload(session, customerId, pdfBuffer(`${stamp}-primary`), filename);
  expectStatus(created, 201, 'create with parsed PO');
  if (created.data.order.order_number !== po) {
    throw new Error(`expected order_number ${po}, got ${created.data.order.order_number}`);
  }
  if (!created.data.order.order_number_key) {
    throw new Error('created order missing order_number_key');
  }
  const createdDetail = await api(`/api/orders/${created.data.order.id}`, { headers: auth(session) });
  const originalPdfPath = createdDetail.order.pdf_path;
  if (!originalPdfPath) throw new Error('created order missing pdf_path');

  const exact = await api(`/api/orders?po=${encodeURIComponent(po.toLowerCase().replace(/\s+/, '-'))}`, {
    headers: auth(session),
  });
  if (exact.orders.length !== 1 || exact.orders[0].id !== created.data.order.id) {
    throw new Error(`exact PO query failed: ${JSON.stringify(exact)}`);
  }

  const firstPiece = createdDetail.order.pieces[0];
  const barcode = `GO-${created.data.order.id}-${firstPiece.id}-${firstPiece.piece_no}`;
  const scanned = await api(`/api/orders?barcode=${encodeURIComponent(barcode)}`, {
    headers: auth(session),
  });
  if (scanned.orders.length !== 1 || scanned.orders[0].id !== created.data.order.id) {
    throw new Error(`barcode query failed: ${barcode} -> ${JSON.stringify(scanned)}`);
  }

  const duplicatePo = await upload(
    session,
    customerId,
    pdfBuffer(`${stamp}-duplicate-po-different-content`),
    `Glass Order - 260620 PO Upload QA p.o. ${po.replace(/^PO\s+/, '')}.pdf`,
  );
  expectStatus(duplicatePo, 409, 'duplicate PO rejected');
  if (!duplicatePo.data || duplicatePo.data.code !== 'DUPLICATE_PO') {
    throw new Error(`duplicate PO missing response code: ${JSON.stringify(duplicatePo.data)}`);
  }
  const afterDuplicate = await api(`/api/orders?po=${encodeURIComponent(po)}`, { headers: auth(session) });
  if (afterDuplicate.orders.length !== 1) {
    throw new Error(`duplicate PO inserted extra order: ${afterDuplicate.orders.length}`);
  }

  const duplicateHash = await upload(
    session,
    customerId,
    pdfBuffer(`${stamp}-primary`),
    `Glass Order - 260620 PO Upload QA PO POU-HASH-${stamp}.pdf`,
  );
  expectStatus(duplicateHash, 409, 'duplicate PDF hash rejected');
  if (!duplicateHash.data || duplicateHash.data.code === 'DUPLICATE_PO') {
    throw new Error(`duplicate hash should not be classified as duplicate PO: ${JSON.stringify(duplicateHash.data)}`);
  }

  const invalidFilename = await upload(
    session,
    customerId,
    pdfBuffer(`${stamp}-invalid-filename`),
    `invalid-${stamp}.pdf`,
  );
  expectStatus(invalidFilename, 400, 'invalid filename rejected');
  if (!invalidFilename.data || invalidFilename.data.code !== 'PO_FILENAME_INVALID') {
    throw new Error(`invalid filename missing response code: ${JSON.stringify(invalidFilename.data)}`);
  }

  const deleted = await raw(`/api/orders/${created.data.order.id}`, {
    method: 'DELETE',
    headers: auth(session),
  });
  expectStatus(deleted, 200, 'delete created order');
  if (!deleted.data || deleted.data.deleted_pieces !== createdDetail.order.pieces.length) {
    throw new Error(`delete response invalid: ${JSON.stringify(deleted.data)}`);
  }
  const deletedDetail = await raw(`/api/orders/${created.data.order.id}`, { headers: auth(session) });
  expectStatus(deletedDetail, 404, 'deleted order not found');
  const deletedPdf = await fetch(`${BASE}${originalPdfPath}`, { headers: auth(session) });
  if (deletedPdf.status !== 404) {
    throw new Error(`deleted order PDF should be removed, got ${deletedPdf.status}`);
  }
  const reuploaded = await upload(
    session,
    customerId,
    pdfBuffer(`${stamp}-reupload-after-delete`),
    filename,
  );
  expectStatus(reuploaded, 201, 'same PO can be reuploaded after delete');
  if (reuploaded.data.order.order_number !== po) {
    throw new Error(`reuploaded order_number mismatch: ${JSON.stringify(reuploaded.data.order)}`);
  }

  console.log(`PO CODE UPLOAD QA PASS customer=${customerId} order=${reuploaded.data.order.id} po=${po}`);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
