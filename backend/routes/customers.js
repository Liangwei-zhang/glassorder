const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendPickupEmail } = require('../services/mailer');

const router = express.Router();
const uploadsBase = (db.runtime && db.runtime.uploadsBase)
  ? db.runtime.uploadsBase
  : path.join(__dirname, '..', 'uploads');

router.use(authenticate);

function publicCustomer(row) {
  return {
    ...row,
    order_count: Number(row.order_count || 0),
    active_order_count: Number(row.active_order_count || 0),
    total_pieces: Number(row.total_pieces || 0),
    finished_pieces: Number(row.finished_pieces || 0),
    picked_pieces: Number(row.picked_pieces || 0),
    pickup_count: Number(row.pickup_count || 0),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validateEmail(email) {
  if (email === undefined || email === null) return null;
  const v = String(email).trim();
  if (v === '') return null;
  if (!EMAIL_RE.test(v)) return { error: 'email is invalid' };
  return v;
}

function validateEmailList(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parts = raw.split(/[;,，；]+/).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return null;

  const seen = new Set();
  const normalized = [];
  for (const email of parts) {
    if (!EMAIL_RE.test(email)) return { error: 'email_cc is invalid' };
    const key = email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }
  return normalized.join(', ');
}

router.get('/', requireRole('boss'), (req, res) => {
  const search = String(req.query.search || '').trim();
  const params = {};
  const where = search
    ? `WHERE c.company LIKE @like OR c.contact_name LIKE @like OR c.phone LIKE @like OR c.email LIKE @like OR c.email_cc LIKE @like`
    : '';
  if (search) params.like = `%${search}%`;
  const rows = db.prepare(`
    WITH order_stats AS (
      SELECT
        customer_id,
        COUNT(*) AS order_count,
        SUM(CASE WHEN archived_at IS NULL THEN 1 ELSE 0 END) AS active_order_count,
        MAX(created_at) AS last_order_at
      FROM orders
      GROUP BY customer_id
    ),
    piece_stats AS (
      SELECT
        o.customer_id,
        COUNT(p.id) AS total_pieces,
        SUM(CASE WHEN p.stage = 'finished' THEN 1 ELSE 0 END) AS finished_pieces,
        SUM(CASE WHEN p.picked_up_at IS NOT NULL THEN 1 ELSE 0 END) AS picked_pieces
      FROM orders o
      LEFT JOIN pieces p ON p.order_id = o.id
      GROUP BY o.customer_id
    ),
    batch_stats AS (
      SELECT
        customer_id,
        COUNT(*) AS pickup_batch_count,
        MAX(picked_at) AS last_batch_pickup_at
      FROM pickup_batches
      WHERE reverted_at IS NULL
      GROUP BY customer_id
    ),
    legacy_pickups AS (
      SELECT
        o.customer_id,
        COUNT(p.id) AS legacy_pickup_count,
        MAX(p.picked_at) AS last_legacy_pickup_at
      FROM pickups p
      JOIN orders o ON o.id = p.order_id
      GROUP BY o.customer_id
    )
    SELECT
      c.id,
      c.company,
      c.contact_name,
      c.phone,
      c.email,
      c.email_cc,
      c.notes,
      c.created_at,
      COALESCE(os.order_count, 0) AS order_count,
      COALESCE(os.active_order_count, 0) AS active_order_count,
      COALESCE(ps.total_pieces, 0) AS total_pieces,
      COALESCE(ps.finished_pieces, 0) AS finished_pieces,
      COALESCE(ps.picked_pieces, 0) AS picked_pieces,
      COALESCE(bs.pickup_batch_count, 0) + COALESCE(lp.legacy_pickup_count, 0) AS pickup_count,
      os.last_order_at,
      CASE
        WHEN bs.last_batch_pickup_at IS NULL THEN lp.last_legacy_pickup_at
        WHEN lp.last_legacy_pickup_at IS NULL THEN bs.last_batch_pickup_at
        WHEN bs.last_batch_pickup_at >= lp.last_legacy_pickup_at THEN bs.last_batch_pickup_at
        ELSE lp.last_legacy_pickup_at
      END AS last_pickup_at
    FROM customers c
    LEFT JOIN order_stats os ON os.customer_id = c.id
    LEFT JOIN piece_stats ps ON ps.customer_id = c.id
    LEFT JOIN batch_stats bs ON bs.customer_id = c.id
    LEFT JOIN legacy_pickups lp ON lp.customer_id = c.id
    ${where}
    ORDER BY c.created_at DESC, c.id DESC
  `).all(params);
  res.json({ customers: rows.map(publicCustomer) });
});

router.post('/', requireRole('boss'), (req, res) => {
  const company = String(req.body.company || '').trim();
  if (!company) return res.status(400).json({ error: 'company is required' });
  const emailCheck = validateEmail(req.body.email);
  if (emailCheck && emailCheck.error) return res.status(400).json({ error: emailCheck.error });
  const emailCcCheck = validateEmailList(req.body.email_cc);
  if (emailCcCheck && emailCcCheck.error) return res.status(400).json({ error: emailCcCheck.error });

  const info = db.prepare(`
    INSERT INTO customers (company, contact_name, phone, email, email_cc, notes)
    VALUES (@company, @contact_name, @phone, @email, @email_cc, @notes)
  `).run({
    company,
    contact_name: req.body.contact_name || null,
    phone: req.body.phone || null,
    email: emailCheck || null,
    email_cc: emailCcCheck || null,
    notes: req.body.notes || null,
  });

  const customer = db.prepare(`
    SELECT id, company, contact_name, phone, email, email_cc, notes, created_at
    FROM customers WHERE id = ?
  `).get(info.lastInsertRowid);
  res.status(201).json({ customer });
});

router.put('/:id', requireRole('boss'), (req, res) => {
  const current = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Customer not found' });

  const company = String(req.body.company || '').trim();
  if (!company) return res.status(400).json({ error: 'company is required' });
  const emailCheck = validateEmail(req.body.email);
  if (emailCheck && emailCheck.error) return res.status(400).json({ error: emailCheck.error });
  const emailCcCheck = validateEmailList(req.body.email_cc);
  if (emailCcCheck && emailCcCheck.error) return res.status(400).json({ error: emailCcCheck.error });

  db.prepare(`
    UPDATE customers
    SET company = @company,
        contact_name = @contact_name,
        phone = @phone,
        email = @email,
        email_cc = @email_cc,
        notes = @notes
    WHERE id = @id
  `).run({
    id: req.params.id,
    company,
    contact_name: req.body.contact_name || null,
    phone: req.body.phone || null,
    email: emailCheck || null,
    email_cc: emailCcCheck || null,
    notes: req.body.notes || null,
  });

  const customer = db.prepare(`
    SELECT id, company, contact_name, phone, email, email_cc, notes, created_at
    FROM customers WHERE id = ?
  `).get(req.params.id);
  res.json({ customer });
});

router.delete('/:id', requireRole('boss'), (req, res) => {
  const current = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Customer not found' });

  const orderCount = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE customer_id = ?').get(req.params.id).n;
  if (orderCount > 0) {
    return res.status(409).json({ error: 'Customer has orders and cannot be deleted' });
  }

  try {
    db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  } catch (err) {
    if (err.code && err.code.startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).json({ error: 'Customer has orders and cannot be deleted' });
    }
    throw err;
  }
  res.json({ ok: true });
});

router.post('/:id/send-slip', requireRole('boss'), (req, res) => {
  const customer = db.prepare(`
    SELECT id, company, email, email_cc FROM customers WHERE id = ?
  `).get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  if (!customer.email) return res.status(400).json({ error: 'Customer email is missing' });

  const row = db.prepare(`
    SELECT
      o.*,
      c.company,
      c.contact_name,
      c.phone AS customer_phone,
      c.email AS customer_email,
      c.email_cc AS customer_email_cc,
      p.slip_pdf_path,
      p.id AS pickup_id
    FROM pickups p
    JOIN orders o ON o.id = p.order_id
    JOIN customers c ON c.id = o.customer_id
    WHERE o.customer_id = ?
    ORDER BY p.picked_at DESC, p.id DESC
    LIMIT 1
  `).get(customer.id);
  if (!row) return res.status(400).json({ error: 'No pickup slip exists for this customer' });

  const slipPath = path.join(uploadsBase, row.slip_pdf_path.replace(/^\/uploads\//, ''));
  if (!fs.existsSync(slipPath)) return res.status(400).json({ error: 'Pickup slip file is missing' });

  const mail = sendPickupEmail({ order: row, slipPath, to: customer.email, cc: customer.email_cc });
  db.prepare(`
    INSERT INTO events (order_id, piece_id, actor_id, action, details)
    VALUES (?, NULL, ?, 'pickup_slip_sent', ?)
  `).run(row.id, req.user.id, JSON.stringify({
    to: customer.email,
    cc: customer.email_cc || null,
    customer_id: customer.id,
    skipped: Boolean(mail.skipped),
    reason: mail.reason || null,
  }));
  res.json({ ok: true, order_id: row.id, pickup_id: row.pickup_id, mail });
});

module.exports = router;
