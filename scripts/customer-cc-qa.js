#!/usr/bin/env node
/* QA for customer email CC validation, persistence, search, and pickup slip mail. */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:8783';
const ROOT = path.join(__dirname, '..');
const SAMPLE_PDF = path.join(ROOT, 'Glass Order - 2605011 Inspire --8 Heritage Cove.pdf');

async function api(apiPath, opts = {}) {
  const res = await fetch(BASE + apiPath, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    const err = new Error(`${apiPath} ${res.status}: ${JSON.stringify(data)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function auth(session) {
  return { Authorization: `Bearer ${session.token}` };
}

async function expectReject(label, fn, status, messagePattern) {
  try {
    await fn();
  } catch (err) {
    if (err.status !== status) {
      throw new Error(`${label}: expected ${status}, got ${err.status || 'no status'} (${err.message})`);
    }
    const errorText = String((err.data && err.data.error) || err.message || '');
    if (messagePattern && !messagePattern.test(errorText)) {
      throw new Error(`${label}: unexpected error text ${errorText}`);
    }
    return;
  }
  throw new Error(`${label}: expected request to fail`);
}

async function createOrder(session, customerId, stamp) {
  const pdf = Buffer.concat([
    fs.readFileSync(SAMPLE_PDF),
    Buffer.from(`\n% customer cc qa ${stamp}\n`),
  ]);
  const form = new FormData();
  form.set('customer_id', String(customerId));
  form.set('priority', 'normal');
  form.set('deadline', '2026-06-30');
  form.set('pdf', new File([pdf], `Glass Order - 260602 CC QA PO CC-${stamp}.pdf`, { type: 'application/pdf' }));
  const created = await api('/api/orders', {
    method: 'POST',
    headers: auth(session),
    body: form,
  });
  return api(`/api/orders/${created.order.id}`, { headers: auth(session) });
}

(async () => {
  const session = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: 'admin123' }),
  });
  const headers = { ...auth(session), 'Content-Type': 'application/json' };
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

  await expectReject('invalid cc create', () => api('/api/customers', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      company: `CC Invalid ${stamp}`,
      email: `cc-invalid-${stamp}@example.test`,
      email_cc: 'bad-address',
    }),
  }), 400, /email_cc/i);

  const created = await api('/api/customers', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      company: `CC QA ${stamp}`,
      contact_name: 'CC Tester',
      phone: '555-0100',
      email: `primary-${stamp}@example.test`,
      email_cc: `Alpha-${stamp}@Example.Test，beta-${stamp}@example.test; alpha-${stamp}@example.test`,
      notes: 'cc qa',
    }),
  });
  const customer = created.customer;
  const expectedCc = `alpha-${stamp}@example.test, beta-${stamp}@example.test`;
  if (customer.email_cc !== expectedCc) {
    throw new Error(`create did not normalize cc: ${customer.email_cc}`);
  }

  const searched = await api(`/api/customers?search=${encodeURIComponent(`beta-${stamp}`)}`, {
    headers: auth(session),
  });
  if (!searched.customers.some((c) => Number(c.id) === Number(customer.id))) {
    throw new Error('customer search did not include email_cc');
  }

  const updatedCc = `ops-${stamp}@example.test, accounting-${stamp}@example.test`;
  const updated = await api(`/api/customers/${customer.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      company: customer.company,
      contact_name: 'CC Tester Updated',
      phone: '555-0101',
      email: customer.email,
      email_cc: updatedCc,
      notes: 'cc qa updated',
    }),
  });
  if (updated.customer.email_cc !== updatedCc) {
    throw new Error(`update did not persist cc: ${updated.customer.email_cc}`);
  }

  await expectReject('invalid cc update', () => api(`/api/customers/${customer.id}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      company: customer.company,
      email: customer.email,
      email_cc: 'ok@example.test; bad',
    }),
  }), 400, /email_cc/i);

  let detail = await createOrder(session, customer.id, stamp);
  for (const piece of detail.order.pieces) {
    for (let i = 0; i < 4; i += 1) {
      await api(`/api/pieces/${piece.id}/advance`, { method: 'POST', headers: auth(session) });
    }
  }
  await api(`/api/orders/${detail.order.id}/ready`, { method: 'POST', headers: auth(session) });
  const pickup = await api(`/api/orders/${detail.order.id}/pickup`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ signer_name: 'CC QA', signer_phone: '555-0102' }),
  });
  if (!pickup.mail || pickup.mail.cc !== updatedCc) {
    throw new Error(`pickup mail did not carry cc: ${JSON.stringify(pickup.mail)}`);
  }

  const resend = await api(`/api/orders/${detail.order.id}/send-slip`, {
    method: 'POST',
    headers: auth(session),
  });
  if (!resend.mail || resend.mail.cc !== updatedCc) {
    throw new Error(`order resend did not carry cc: ${JSON.stringify(resend.mail)}`);
  }

  const customerResend = await api(`/api/customers/${customer.id}/send-slip`, {
    method: 'POST',
    headers: auth(session),
  });
  if (!customerResend.mail || customerResend.mail.cc !== updatedCc) {
    throw new Error(`customer resend did not carry cc: ${JSON.stringify(customerResend.mail)}`);
  }

  detail = await api(`/api/orders/${detail.order.id}`, { headers: auth(session) });
  const sentEvents = detail.order.events
    .filter((event) => event.action === 'pickup_slip_sent')
    .map((event) => JSON.parse(event.details || '{}'));
  if (!sentEvents.some((event) => event.cc === updatedCc)) {
    throw new Error(`pickup_slip_sent event missing cc: ${JSON.stringify(sentEvents)}`);
  }

  console.log(`CUSTOMER CC QA PASS customer=${customer.id} order=${detail.order.id} cc=${updatedCc}`);
})().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
