const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { createPickupBatchSlip } = require('../services/pickupSlip');
const { syncOrderStatusFromPieces } = require('../services/orderStatus');
const { decodeOptionalPngSignature, decodePngSignature } = require('../services/signature');
const { poLookupKeys } = require('../services/poCode');

const router = express.Router();
const uploadsBase = (db.runtime && db.runtime.uploadsBase)
  ? db.runtime.uploadsBase
  : path.join(__dirname, '..', 'uploads');
const SIGN_REQUEST_TTL_MINUTES = 15;

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

function queryString(value) {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').trim();
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

function availableRows(customerId, poKeys = [], options = {}) {
  const poFilter = poKeys.length
    ? `AND o.order_number_key IN (${poKeys.map((_, index) => `@po_key_${index}`).join(', ')})`
    : '';
  const holdFilter = options.includeHold ? '' : 'AND p.hold = 0';
  const params = { customer_id: customerId };
  poKeys.forEach((key, index) => {
    params[`po_key_${index}`] = key;
  });
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
    WHERE o.customer_id = @customer_id
      AND o.archived_at IS NULL
      ${poFilter}
      AND p.stage = 'finished'
      ${holdFilter}
      AND p.picked_up_at IS NULL
    ORDER BY o.deadline IS NULL, o.deadline, o.created_at, o.id, p.piece_no
  `).all(params);
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

function body(req) {
  return req.body || {};
}

function bodyBool(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'hold'].includes(text)) return true;
  if (['0', 'false', 'no', 'off', 'unhold'].includes(text)) return false;
  return fallback;
}

function queryBool(value) {
  return bodyBool(queryString(value), false);
}

function signTokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function newSignToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function requestOrigin(req) {
  const host = req.get('host');
  if (!host) return '';
  return `${req.protocol}://${host}`;
}

function signUrl(req, token) {
  return `${requestOrigin(req)}/customer-sign.html?t=${encodeURIComponent(token)}`;
}

function jsonPieceIds(value) {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter((id) => Number.isInteger(id) && id > 0);
  } catch (err) {
    return [];
  }
}

function uniquePieceIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function selectedPickupRows(pieceIds) {
  const ids = uniquePieceIds(pieceIds);
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db.prepare(`
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
  `).all(...ids);
}

function validatePickupRows(pieceIds, rows) {
  const ids = uniquePieceIds(pieceIds);
  if (!ids.length) return { status: 400, error: 'piece_ids are required' };
  if (rows.length !== ids.length) return { status: 404, error: 'Some pieces were not found' };
  const customerIds = new Set(rows.map((row) => row.customer_id));
  if (customerIds.size !== 1) return { status: 400, error: 'Pickup batch must contain one customer only' };
  const invalid = rows.find((row) => row.archived_at || row.stage !== 'finished' || row.hold || row.picked_up_at);
  if (invalid) return { status: 400, error: 'Only finished, unpicked pieces can be picked up' };
  return null;
}

function customerFromRows(rows) {
  return {
    id: rows[0].customer_id,
    company: rows[0].company,
    contact_name: rows[0].contact_name,
    phone: rows[0].customer_phone,
    email: rows[0].customer_email,
  };
}

function publicSignSummary(rows) {
  const orders = new Map();
  for (const row of rows) {
    if (!orders.has(row.order_id)) {
      orders.set(row.order_id, {
        order_number: row.order_number,
        project_name: row.project_name || '',
        pieces: [],
      });
    }
    orders.get(row.order_id).pieces.push({
      piece_no: row.piece_no,
      size: row.size || '',
      type: row.type || '',
      thickness: row.thickness || '',
      weight: row.weight || '',
    });
  }
  return {
    total_pieces: rows.length,
    order_count: orders.size,
    orders: [...orders.values()],
  };
}

function secondsUntil(sqlDate) {
  const expires = new Date(String(sqlDate || '').replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(expires)) return 0;
  return Math.max(0, Math.floor((expires - Date.now()) / 1000));
}

function markExpiredSignRequests() {
  db.prepare(`
    UPDATE pickup_sign_requests
    SET status = 'expired'
    WHERE status = 'pending'
      AND expires_at <= datetime('now')
  `).run();
}

function signRequestByToken(token) {
  markExpiredSignRequests();
  return db.prepare(`
    SELECT
      r.*,
      c.company
    FROM pickup_sign_requests r
    JOIN customers c ON c.id = r.customer_id
    WHERE r.token_hash = ?
  `).get(signTokenHash(token));
}

function signRequestById(id) {
  markExpiredSignRequests();
  return db.prepare(`
    SELECT
      r.*,
      c.company,
      b.batch_number
    FROM pickup_sign_requests r
    JOIN customers c ON c.id = r.customer_id
    LEFT JOIN pickup_batches b ON b.id = r.pickup_batch_id
    WHERE r.id = ?
  `).get(id);
}

function bossSignRequestPayload(row) {
  if (!row) return null;
  const pieceIds = jsonPieceIds(row.piece_ids);
  return {
    id: row.id,
    status: row.status,
    customer: { id: row.customer_id, company: row.company },
    total_pieces: pieceIds.length,
    piece_ids: pieceIds,
    expires_at: row.expires_at,
    seconds_remaining: row.status === 'pending' ? secondsUntil(row.expires_at) : 0,
    signed_at: row.signed_at,
    cancelled_at: row.cancelled_at,
    pickup_batch_id: row.pickup_batch_id,
    batch_number: row.batch_number || null,
  };
}

async function createSignedPickupBatch({ rows, signerName, signerPhone, signatureBuffer, actorId, signRequestId = null }) {
  const customer = customerFromRows(rows);
  const signatureDir = path.join(uploadsBase, 'signatures');
  const slipDir = path.join(uploadsBase, 'slips');
  fs.mkdirSync(slipDir, { recursive: true });
  const batchNumber = db.transaction(() => nextBatchNumber())();
  const fileToken = `${Date.now()}-${process.hrtime.bigint().toString(36)}`;
  let signatureFile = '';
  let signaturePath = '';
  if (signatureBuffer) {
    fs.mkdirSync(signatureDir, { recursive: true });
    signatureFile = `signature-${batchNumber}-${fileToken}.png`;
    signaturePath = path.join(signatureDir, signatureFile);
    fs.writeFileSync(signaturePath, signatureBuffer);
  }

  const slipFile = `pickup-${batchNumber}-${fileToken}.pdf`;
  const slipPath = path.join(slipDir, slipFile);
  await createPickupBatchSlip({
    batch: { batch_number: batchNumber },
    customer,
    items: rows,
    signerName,
    signerPhone: signerPhone || '',
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
      signerPhone || null,
      signatureFile ? `/uploads/signatures/${signatureFile}` : '',
      `/uploads/slips/${slipFile}`,
      actorId || null,
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
        AND stage = 'finished'
        AND hold = 0
        AND picked_up_at IS NULL
    `);
    const orderIds = new Set();
    for (const row of rows) {
      const marked = markPiece.run(id, row.id);
      if (marked.changes !== 1) {
        const err = new Error('Only finished, unpicked pieces can be picked up');
        err.status = 400;
        throw err;
      }
      insertItem.run(id, row.order_id, row.id);
      orderIds.add(row.order_id);
      insertEvent(row.order_id, row.id, actorId || null, 'piece_picked_up', {
        batch_id: id,
        batch_number: batchNumber,
        signer_name: signerName,
        sign_request_id: signRequestId || null,
      });
    }
    for (const orderId of orderIds) syncOrderStatusFromPieces(orderId);
    if (signRequestId) {
      const updated = db.prepare(`
        UPDATE pickup_sign_requests
        SET status = 'signed',
            signer_name = ?,
            signer_phone = ?,
            signature_path = ?,
            slip_pdf_path = ?,
            pickup_batch_id = ?,
            signed_at = datetime('now')
        WHERE id = ?
          AND status = 'processing'
      `).run(
        signerName,
        signerPhone || null,
        signatureFile ? `/uploads/signatures/${signatureFile}` : '',
        `/uploads/slips/${slipFile}`,
        id,
        signRequestId,
      );
      if (updated.changes !== 1) {
        const err = new Error('Signing request is no longer active');
        err.status = 409;
        throw err;
      }
    }
    return id;
  })();
  return batchId;
}

router.get('/sign/:token', (req, res) => {
  const token = queryString(req.params.token);
  if (!token) return res.status(404).json({ error: 'Signing request not found' });
  const request = signRequestByToken(token);
  if (!request) return res.status(404).json({ error: 'Signing request not found' });
  if (request.status !== 'pending') {
    return res.status(410).json({ error: 'Signing request is no longer active', status: request.status });
  }
  const pieceIds = jsonPieceIds(request.piece_ids);
  const rows = selectedPickupRows(pieceIds);
  const invalid = validatePickupRows(pieceIds, rows);
  if (invalid) return res.status(410).json({ error: 'Signing request is no longer active', status: 'stale' });
  const summary = publicSignSummary(rows);
  res.json({
    status: 'pending',
    expires_at: request.expires_at,
    seconds_remaining: secondsUntil(request.expires_at),
    customer: { company: request.company },
    summary: {
      total_pieces: summary.total_pieces,
      order_count: summary.order_count,
    },
    orders: summary.orders,
  });
});

router.post('/sign/:token', async (req, res, next) => {
  const token = queryString(req.params.token);
  const signerName = String(body(req).signer_name || '').trim();
  if (!signerName) return res.status(400).json({ error: 'signer_name is required' });
  const decodedSignature = decodePngSignature(body(req).signature_base64);
  if (decodedSignature.error) return res.status(400).json({ error: decodedSignature.error });
  const signerPhone = String(body(req).signer_phone || '').trim();

  let request = signRequestByToken(token);
  if (!request) return res.status(404).json({ error: 'Signing request not found' });
  if (request.status !== 'pending') {
    return res.status(410).json({ error: 'Signing request is no longer active', status: request.status });
  }
  const pieceIds = jsonPieceIds(request.piece_ids);
  let rows = selectedPickupRows(pieceIds);
  const invalid = validatePickupRows(pieceIds, rows);
  if (invalid) return res.status(410).json({ error: 'Signing request is no longer active', status: 'stale' });

  const claimed = db.prepare(`
    UPDATE pickup_sign_requests
    SET status = 'processing'
    WHERE id = ?
      AND status = 'pending'
      AND expires_at > datetime('now')
  `).run(request.id);
  if (claimed.changes !== 1) {
    request = signRequestById(request.id);
    return res.status(410).json({
      error: 'Signing request is no longer active',
      status: request ? request.status : 'unknown',
    });
  }

  try {
    rows = selectedPickupRows(pieceIds);
    const recheck = validatePickupRows(pieceIds, rows);
    if (recheck) {
      db.prepare(`
        UPDATE pickup_sign_requests
        SET status = 'expired'
        WHERE id = ? AND status = 'processing'
      `).run(request.id);
      return res.status(410).json({ error: 'Signing request is no longer active', status: 'stale' });
    }
    const batchId = await createSignedPickupBatch({
      rows,
      signerName,
      signerPhone,
      signatureBuffer: decodedSignature.buffer,
      actorId: request.created_by,
      signRequestId: request.id,
    });
    res.status(201).json({
      ok: true,
      status: 'signed',
      batch_id: batchId,
      message: 'Pickup signed',
    });
  } catch (err) {
    db.prepare(`
      UPDATE pickup_sign_requests
      SET status = 'pending'
      WHERE id = ? AND status = 'processing' AND pickup_batch_id IS NULL
    `).run(request.id);
    next(err);
  }
});

router.use(authenticate);

router.post('/sign-requests', requireRole('boss'), async (req, res, next) => {
  try {
    const pieceIds = uniquePieceIds(body(req).piece_ids);
    const rows = selectedPickupRows(pieceIds);
    const invalid = validatePickupRows(pieceIds, rows);
    if (invalid) return res.status(invalid.status).json({ error: invalid.error });
    const customer = customerFromRows(rows);
    const token = newSignToken();
    const tokenHash = signTokenHash(token);
    const expiresAt = db.prepare(`SELECT datetime('now', ?) AS expires_at`)
      .get(`+${SIGN_REQUEST_TTL_MINUTES} minutes`).expires_at;
    const link = signUrl(req, token);
    const qrSvg = await QRCode.toString(link, {
      type: 'svg',
      margin: 1,
      width: 240,
      errorCorrectionLevel: 'M',
      color: { dark: '#18181b', light: '#ffffff' },
    });
    db.transaction(() => {
      db.prepare(`
        UPDATE pickup_sign_requests
        SET status = 'cancelled',
            cancelled_at = datetime('now'),
            cancelled_by = ?,
            cancel_reason = 'replaced'
        WHERE customer_id = ?
          AND status = 'pending'
      `).run(req.user.id, customer.id);
      db.prepare(`
        INSERT INTO pickup_sign_requests (
          token_hash, customer_id, piece_ids, created_by, expires_at
        )
        VALUES (?, ?, ?, ?, ?)
      `).run(tokenHash, customer.id, JSON.stringify(pieceIds), req.user.id, expiresAt);
    })();
    const request = db.prepare(`
      SELECT * FROM pickup_sign_requests WHERE token_hash = ?
    `).get(tokenHash);
    const summary = publicSignSummary(rows);
    res.status(201).json({
      request: {
        ...bossSignRequestPayload({ ...request, company: customer.company }),
        sign_url: link,
        qr_svg: qrSvg,
        summary: {
          total_pieces: summary.total_pieces,
          order_count: summary.order_count,
        },
        orders: summary.orders,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get('/sign-requests/:id', requireRole('boss'), (req, res) => {
  const id = safeInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id is required' });
  const request = signRequestById(id);
  if (!request) return res.status(404).json({ error: 'Signing request not found' });
  res.json({ request: bossSignRequestPayload(request) });
});

router.post('/sign-requests/:id/cancel', requireRole('boss'), (req, res) => {
  const id = safeInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'id is required' });
  const request = signRequestById(id);
  if (!request) return res.status(404).json({ error: 'Signing request not found' });
  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'Signing request is no longer active', status: request.status });
  }
  db.prepare(`
    UPDATE pickup_sign_requests
    SET status = 'cancelled',
        cancelled_at = datetime('now'),
        cancelled_by = ?,
        cancel_reason = ?
    WHERE id = ?
      AND status = 'pending'
  `).run(req.user.id, String(body(req).reason || 'cancelled').slice(0, 120), id);
  res.json({ ok: true, request: bossSignRequestPayload(signRequestById(id)) });
});

router.get('/available', requireRole('boss'), (req, res) => {
  const customerId = safeInt(req.query.customer_id);
  if (!customerId) return res.status(400).json({ error: 'customer_id is required' });
  const po = queryString(req.query.po);
  const poKeys = po ? poLookupKeys(po) : [];
  const includeHold = queryBool(req.query.include_hold);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });
  const rows = availableRows(customerId, poKeys, { includeHold });
  res.json({
    customer,
    orders: groupAvailable(rows),
    pieces: rows,
    total_pieces: rows.length,
    hold_pieces: rows.filter((row) => row.hold).length,
    po: po || null,
    include_hold: includeHold,
  });
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

router.post('/hold-order', requireRole('boss'), (req, res) => {
  const orderId = safeInt(body(req).order_id);
  if (!orderId) return res.status(400).json({ error: 'order_id is required' });
  const hold = bodyBool(body(req).hold, true);
  const order = db.prepare(`
    SELECT o.id, o.order_number, o.customer_id, c.company
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.id = ?
  `).get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const total = db.prepare(`
    SELECT COUNT(*) AS n
    FROM pieces
    WHERE order_id = ?
      AND stage = 'finished'
      AND picked_up_at IS NULL
  `).get(order.id).n;
  if (!total) return res.status(400).json({ error: 'No finished unpicked pieces found for this order' });

  const info = db.prepare(`
    UPDATE pieces
    SET hold = ?
    WHERE order_id = ?
      AND stage = 'finished'
      AND picked_up_at IS NULL
      AND hold != ?
  `).run(hold ? 1 : 0, order.id, hold ? 1 : 0);
  insertEvent(order.id, null, req.user.id, hold ? 'pickup_order_hold' : 'pickup_order_unhold', {
    order_number: order.order_number,
    customer_id: order.customer_id,
    changed: info.changes,
    total,
    note: body(req).note || null,
  });
  res.json({ ok: true, scope: 'order', hold, changed: info.changes, total, order });
});

router.post('/hold-customer', requireRole('boss'), (req, res) => {
  const customerId = safeInt(body(req).customer_id);
  if (!customerId) return res.status(400).json({ error: 'customer_id is required' });
  const hold = bodyBool(body(req).hold, true);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const params = { customer_id: customer.id, hold: hold ? 1 : 0 };
  const total = db.prepare(`
    SELECT COUNT(*) AS n
    FROM pieces p
    JOIN orders o ON o.id = p.order_id
    WHERE o.customer_id = @customer_id
      AND o.archived_at IS NULL
      AND p.stage = 'finished'
      AND p.picked_up_at IS NULL
  `).get(params).n;
  if (!total) return res.status(400).json({ error: 'No finished unpicked pieces found for this customer' });

  const affectedOrders = db.prepare(`
    SELECT p.order_id, o.order_number, COUNT(*) AS count
    FROM pieces p
    JOIN orders o ON o.id = p.order_id
    WHERE o.customer_id = @customer_id
      AND o.archived_at IS NULL
      AND p.stage = 'finished'
      AND p.picked_up_at IS NULL
      AND p.hold != @hold
    GROUP BY p.order_id, o.order_number
    ORDER BY o.order_number
  `).all(params);

  const changed = db.transaction(() => {
    const info = db.prepare(`
      UPDATE pieces
      SET hold = @hold
      WHERE id IN (
        SELECT p.id
        FROM pieces p
        JOIN orders o ON o.id = p.order_id
        WHERE o.customer_id = @customer_id
          AND o.archived_at IS NULL
          AND p.stage = 'finished'
          AND p.picked_up_at IS NULL
          AND p.hold != @hold
      )
    `).run(params);
    for (const row of affectedOrders) {
      insertEvent(row.order_id, null, req.user.id, hold ? 'pickup_customer_hold' : 'pickup_customer_unhold', {
        customer_id: customer.id,
        company: customer.company,
        order_number: row.order_number,
        changed: row.count,
        total,
        note: body(req).note || null,
      });
    }
    return info.changes;
  })();
  res.json({ ok: true, scope: 'customer', hold, changed, total, orders: affectedOrders, customer });
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
    const pieceIds = uniquePieceIds(req.body.piece_ids);
    const signerName = String(req.body.signer_name || '').trim();
    if (!signerName) return res.status(400).json({ error: 'signer_name is required' });
    const decodedSignature = decodeOptionalPngSignature(req.body.signature_base64);
    if (decodedSignature.error) return res.status(400).json({ error: decodedSignature.error });
    const rows = selectedPickupRows(pieceIds);
    const invalid = validatePickupRows(pieceIds, rows);
    if (invalid) return res.status(invalid.status).json({ error: invalid.error });
    const batchId = await createSignedPickupBatch({
      rows,
      signerName,
      signerPhone: String(req.body.signer_phone || '').trim(),
      signatureBuffer: decodedSignature.buffer,
      actorId: req.user.id,
    });
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
