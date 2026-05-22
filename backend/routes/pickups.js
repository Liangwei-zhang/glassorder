const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { createPickupBatchSlip } = require('../services/pickupSlip');
const { syncOrderStatusFromPieces } = require('../services/orderStatus');
const { decodePngSignature } = require('../services/signature');

const router = express.Router();
const uploadsBase = (db.runtime && db.runtime.uploadsBase)
  ? db.runtime.uploadsBase
  : path.join(__dirname, '..', 'uploads');

router.use(authenticate);

function insertEvent(orderId, pieceId, actorId, action, details) {
  db.prepare(`
    INSERT INTO events (order_id, piece_id, actor_id, action, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(orderId, pieceId || null, actorId || null, action, details ? JSON.stringify(details) : null);
}

function safeInt(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function batchPrefix() {
  const date = new Date().toISOString().slice(2, 10).replace(/-/g, '');
  return `PU-${date}`;
}

function nextBatchNumber() {
  const prefix = batchPrefix();
  const maxExisting = db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(batch_number, ?) AS INTEGER)), 0) AS seq
    FROM pickup_batches
    WHERE batch_number LIKE ?
  `).get(prefix.length + 2, `${prefix}-%`).seq;
  const insert = db.prepare(`
    INSERT INTO pickup_batch_counters (prefix, next_seq)
    VALUES (?, ?)
    ON CONFLICT(prefix) DO UPDATE SET
      next_seq = CASE
        WHEN pickup_batch_counters.next_seq < excluded.next_seq THEN excluded.next_seq
        ELSE pickup_batch_counters.next_seq
      END
  `);
  const bump = db.prepare(`
    UPDATE pickup_batch_counters
    SET next_seq = next_seq + 1
    WHERE prefix = ?
    RETURNING next_seq - 1 AS seq
  `);
  insert.run(prefix, Number(maxExisting || 0) + 1);
  const row = bump.get(prefix);
  const seq = row && Number(row.seq);
  if (!Number.isInteger(seq) || seq < 1) {
    const err = new Error('Failed to allocate pickup batch number');
    err.status = 500;
    throw err;
  }
  return `${prefix}-${String(seq).padStart(4, '0')}`;
}

function availableRows(customerId) {
  return db.prepare(`
    SELECT
      p.*,
      o.order_number,
      o.project_name,
      o.priority,
      o.deadline,
      c.company,
      c.contact_name,
      c.phone AS customer_phone,
      c.email AS customer_email
    FROM pieces p
    JOIN orders o ON o.id = p.order_id
    JOIN customers c ON c.id = o.customer_id
    WHERE o.customer_id = ?
      AND o.archived_at IS NULL
      AND p.stage = 'finished'
      AND p.hold = 0
      AND p.picked_up_at IS NULL
    ORDER BY o.deadline IS NULL, o.deadline, o.created_at, o.id, p.piece_no
  `).all(customerId);
}

function groupAvailable(rows) {
  const orders = new Map();
  for (const row of rows) {
    if (!orders.has(row.order_id)) {
      orders.set(row.order_id, {
        order_id: row.order_id,
        order_number: row.order_number,
        project_name: row.project_name,
        priority: row.priority,
        deadline: row.deadline,
        pieces: [],
      });
    }
    orders.get(row.order_id).pieces.push(row);
  }
  return [...orders.values()];
}

function batchItems(batchId) {
  return db.prepare(`
    SELECT
      pi.*,
      p.piece_no,
      p.size,
      p.type,
      p.thickness,
      p.weight,
      p.stage,
      p.picked_up_at AS piece_picked_up_at,
      o.order_number,
      o.project_name,
      c.company
    FROM pickup_items pi
    JOIN pieces p ON p.id = pi.piece_id
    JOIN orders o ON o.id = pi.order_id
    JOIN customers c ON c.id = o.customer_id
    WHERE pi.batch_id = ?
    ORDER BY o.order_number, p.piece_no
  `).all(batchId);
}

function getBatch(batchId) {
  const batch = db.prepare(`
    SELECT
      b.*,
      c.company,
      c.contact_name,
      c.phone AS customer_phone,
      c.email AS customer_email,
      u.name AS picked_by_name
    FROM pickup_batches b
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN users u ON u.id = b.picked_by
    WHERE b.id = ?
  `).get(batchId);
  if (!batch) return null;
  batch.items = batchItems(batch.id);
  return batch;
}

router.get('/available', requireRole('boss'), (req, res) => {
  const customerId = safeInt(req.query.customer_id);
  if (!customerId) return res.status(400).json({ error: 'customer_id is required' });
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const rows = availableRows(customerId);
  res.json({ customer, orders: groupAvailable(rows), pieces: rows, total_pieces: rows.length });
});

router.get('/available/all', requireRole('boss'), (req, res) => {
  const rows = db.prepare(`
    SELECT
      p.*,
      o.order_number,
      o.project_name,
      o.priority,
      o.deadline,
      c.id AS customer_id,
      c.company,
      c.contact_name,
      c.phone AS customer_phone,
      c.email AS customer_email
    FROM pieces p
    JOIN orders o ON o.id = p.order_id
    JOIN customers c ON c.id = o.customer_id
    WHERE o.archived_at IS NULL
      AND p.stage = 'finished'
      AND p.hold = 0
      AND p.picked_up_at IS NULL
    ORDER BY o.created_at DESC, o.id DESC, p.piece_no
    LIMIT 500
  `).all();
  res.json({ pieces: rows, total_pieces: rows.length });
});

router.get('/batches', requireRole('boss'), (req, res) => {
  const customerId = safeInt(req.query.customer_id);
  const where = [];
  const params = {};
  if (customerId) {
    where.push('b.customer_id = @customer_id');
    params.customer_id = customerId;
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const batches = db.prepare(`
    SELECT
      b.*,
      c.company,
      COUNT(pi.id) AS total_items,
      SUM(CASE WHEN pi.reverted_at IS NULL THEN 1 ELSE 0 END) AS active_items,
      SUM(CASE WHEN pi.reverted_at IS NOT NULL THEN 1 ELSE 0 END) AS reverted_items
    FROM pickup_batches b
    JOIN customers c ON c.id = b.customer_id
    LEFT JOIN pickup_items pi ON pi.batch_id = b.id
    ${whereSql}
    GROUP BY b.id
    ORDER BY b.picked_at DESC, b.id DESC
    LIMIT 100
  `).all(params);
  res.json({ batches });
});

router.get('/batches/:id', requireRole('boss'), (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Pickup batch not found' });
  res.json({ batch });
});

router.post('/batches', requireRole('boss'), async (req, res, next) => {
  try {
    const pieceIds = Array.isArray(req.body.piece_ids)
      ? req.body.piece_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    if (!pieceIds.length) return res.status(400).json({ error: 'piece_ids are required' });
    const signerName = String(req.body.signer_name || '').trim();
    if (!signerName) return res.status(400).json({ error: 'signer_name is required' });
    const decodedSignature = decodePngSignature(req.body.signature_base64);
    if (decodedSignature.error) return res.status(400).json({ error: decodedSignature.error });
    const signatureBuffer = decodedSignature.buffer;

    const placeholders = pieceIds.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT
        p.*,
        o.order_number,
        o.project_name,
        o.customer_id,
        o.archived_at,
        c.company,
        c.contact_name,
        c.phone AS customer_phone,
        c.email AS customer_email
      FROM pieces p
      JOIN orders o ON o.id = p.order_id
      JOIN customers c ON c.id = o.customer_id
      WHERE p.id IN (${placeholders})
      ORDER BY o.order_number, p.piece_no
    `).all(...pieceIds);
    if (rows.length !== new Set(pieceIds).size) {
      return res.status(404).json({ error: 'Some pieces were not found' });
    }
    const customerIds = new Set(rows.map((row) => row.customer_id));
    if (customerIds.size !== 1) return res.status(400).json({ error: 'Pickup batch must contain one customer only' });
    const invalid = rows.find((row) => row.archived_at || row.stage !== 'finished' || row.hold || row.picked_up_at);
    if (invalid) return res.status(400).json({ error: 'Only finished, unpicked pieces can be picked up' });

    const customer = {
      id: rows[0].customer_id,
      company: rows[0].company,
      contact_name: rows[0].contact_name,
      phone: rows[0].customer_phone,
      email: rows[0].customer_email,
    };
    const signatureDir = path.join(uploadsBase, 'signatures');
    const slipDir = path.join(uploadsBase, 'slips');
    fs.mkdirSync(signatureDir, { recursive: true });
    fs.mkdirSync(slipDir, { recursive: true });
    const batchNumber = db.transaction(() => nextBatchNumber())();
    const fileToken = `${Date.now()}-${process.hrtime.bigint().toString(36)}`;
    const signatureFile = `signature-${batchNumber}-${fileToken}.png`;
    const signaturePath = path.join(signatureDir, signatureFile);
    fs.writeFileSync(signaturePath, signatureBuffer);

    const slipFile = `pickup-${batchNumber}-${fileToken}.pdf`;
    const slipPath = path.join(slipDir, slipFile);
    await createPickupBatchSlip({
      batch: { batch_number: batchNumber },
      customer,
      items: rows,
      signerName,
      signerPhone: req.body.signer_phone || '',
      signaturePath,
      outputPath: slipPath,
    });

    const batchId = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO pickup_batches (
          batch_number, customer_id, signer_name, signer_phone, signature_path, slip_pdf_path, picked_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        batchNumber,
        customer.id,
        signerName,
        req.body.signer_phone || null,
        `/uploads/signatures/${signatureFile}`,
        `/uploads/slips/${slipFile}`,
        req.user.id,
      );
      const id = info.lastInsertRowid;
      const insertItem = db.prepare(`
        INSERT INTO pickup_items (batch_id, order_id, piece_id)
        VALUES (?, ?, ?)
      `);
      const markPiece = db.prepare(`
        UPDATE pieces
        SET picked_up_at = datetime('now'),
            pickup_batch_id = ?
        WHERE id = ?
      `);
      const orderIds = new Set();
      for (const row of rows) {
        insertItem.run(id, row.order_id, row.id);
        markPiece.run(id, row.id);
        orderIds.add(row.order_id);
        insertEvent(row.order_id, row.id, req.user.id, 'piece_picked_up', {
          batch_id: id,
          batch_number: batchNumber,
          signer_name: signerName,
        });
      }
      for (const orderId of orderIds) syncOrderStatusFromPieces(orderId);
      return id;
    })();

    res.status(201).json({ batch: getBatch(batchId) });
  } catch (err) {
    next(err);
  }
});

router.post('/batches/:id/revert', requireRole('boss'), (req, res) => {
  const batch = getBatch(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Pickup batch not found' });
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!reason) return res.status(400).json({ error: 'reason is required' });
  const requested = Array.isArray(req.body.piece_ids)
    ? req.body.piece_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  const activeItems = batch.items.filter((item) => !item.reverted_at);
  const selected = requested.length
    ? activeItems.filter((item) => requested.includes(Number(item.piece_id)))
    : activeItems;
  if (!selected.length) return res.status(400).json({ error: 'No active pickup items selected' });

  db.transaction(() => {
    const revertItem = db.prepare(`
      UPDATE pickup_items
      SET reverted_at = datetime('now'),
          reverted_by = ?,
          revert_reason = ?
      WHERE id = ? AND reverted_at IS NULL
    `);
    const revertPiece = db.prepare(`
      UPDATE pieces
      SET picked_up_at = NULL,
          pickup_batch_id = NULL
      WHERE id = ?
    `);
    const orderIds = new Set();
    for (const item of selected) {
      revertItem.run(req.user.id, reason, item.id);
      revertPiece.run(item.piece_id);
      orderIds.add(item.order_id);
      insertEvent(item.order_id, item.piece_id, req.user.id, 'piece_pickup_reverted', {
        batch_id: batch.id,
        batch_number: batch.batch_number,
        reason,
      });
    }
    const remainingActive = db.prepare(`
      SELECT COUNT(*) AS n FROM pickup_items WHERE batch_id = ? AND reverted_at IS NULL
    `).get(batch.id).n;
    if (remainingActive === 0) {
      db.prepare(`
        UPDATE pickup_batches
        SET reverted_at = datetime('now'),
            reverted_by = ?,
            revert_reason = ?
        WHERE id = ?
      `).run(req.user.id, reason, batch.id);
    }
    for (const orderId of orderIds) syncOrderStatusFromPieces(orderId);
  })();

  res.json({ ok: true, batch: getBatch(batch.id), reverted: selected.length });
});

module.exports = router;
