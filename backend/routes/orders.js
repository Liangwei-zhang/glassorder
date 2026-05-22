const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { randomUUID } = require('crypto');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { parsePdf } = require('../services/pdfParser');
const { createPickupSlip } = require('../services/slipPdf');
const { sendPickupEmail } = require('../services/mailer');
const { decodePngSignature } = require('../services/signature');
const {
  completedStepsJSON,
  hydratePieceWorkflow,
  normalizeRequiredSteps,
  processConfigJSON,
} = require('../services/pieceWorkflow');
const { decorateOrder, syncOrderStatusFromPieces } = require('../services/orderStatus');

const router = express.Router();
const ALLOWED_PRIORITIES = new Set(['normal', 'rush', 'rework']);

const uploadsBase = (db.runtime && db.runtime.uploadsBase)
  ? db.runtime.uploadsBase
  : path.join(__dirname, '..', 'uploads');
const pdfDir = path.join(uploadsBase, 'pdfs');
const orderUploadsDir = path.join(uploadsBase, 'orders');
fs.mkdirSync(pdfDir, { recursive: true });
fs.mkdirSync(orderUploadsDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination(req, file, cb) {
      cb(null, pdfDir);
    },
    filename(req, file, cb) {
      const safeOriginal = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '-');
      cb(null, `${Date.now()}-${randomUUID()}-${safeOriginal}`);
    },
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      const err = new Error('Only PDF uploads are supported');
      err.status = 400;
      cb(err);
    }
  },
});

function uploadPdf(req, res, next) {
  upload.single('pdf')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'PDF too large (max 25MB)' });
    }
    return res.status(err.status || 400).json({ error: err.message || 'Upload failed' });
  });
}

function silentRm(target) {
  if (!target) return;
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    /* swallow cleanup errors */
  }
}

router.use(authenticate);

function safeSegment(value) {
  return String(value || 'order')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'order';
}

function uniqueOrderNumber(base) {
  const cleanBase = safeSegment(base || `order-${Date.now()}`);
  const exists = (value) => db.prepare('SELECT id FROM orders WHERE order_number = ?').get(value);
  if (!exists(cleanBase)) return cleanBase;

  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${cleanBase}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  return `${cleanBase}-${Date.now()}`;
}

function insertEvent(orderId, pieceId, actorId, action, details) {
  db.prepare(`
    INSERT INTO events (order_id, piece_id, actor_id, action, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(orderId, pieceId || null, actorId || null, action, details ? JSON.stringify(details) : null);
}

function fileHash(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function orderSelect() {
  return `
    SELECT
      o.*,
      c.company,
      c.contact_name,
      c.phone AS customer_phone,
      c.email AS customer_email,
      COUNT(p.id) AS total_pieces,
      SUM(CASE WHEN p.stage = 'finished' THEN 1 ELSE 0 END) AS finished_pieces,
      SUM(CASE WHEN p.rework = 1 THEN 1 ELSE 0 END) AS rework_pieces,
      SUM(CASE WHEN p.broken = 1 THEN 1 ELSE 0 END) AS broken_pieces,
      SUM(CASE WHEN p.picked_up_at IS NOT NULL THEN 1 ELSE 0 END) AS picked_pieces
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    LEFT JOIN pieces p ON p.order_id = o.id
  `;
}

function getOrderWithPieces(orderId) {
  const order = decorateOrder(db.prepare(`${orderSelect()} WHERE o.id = ? GROUP BY o.id`).get(orderId));
  if (!order) return null;
  order.pieces = db.prepare('SELECT * FROM pieces WHERE order_id = ? ORDER BY piece_no')
    .all(orderId)
    .map((piece) => hydratePieceWorkflow({
      ...piece,
      hold: Boolean(piece.hold),
      rework: Boolean(piece.rework),
      broken: Boolean(piece.broken),
    }));
  order.events = db.prepare(`
    SELECT e.*, u.name AS actor_name
    FROM events e
    LEFT JOIN users u ON u.id = e.actor_id
    WHERE e.order_id = ?
    ORDER BY e.at DESC, e.id DESC
  `).all(orderId);
  order.pickups = db.prepare('SELECT * FROM pickups WHERE order_id = ? ORDER BY id DESC').all(orderId);
  return order;
}

function safeInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function queryString(value) {
  if (Array.isArray(value)) return String(value[0] || '').trim();
  return String(value || '').trim();
}

function compactSearch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
}

function compactSql(expr) {
  const base = `LOWER(COALESCE(${expr}, ''))`;
  return [
    ['-', ''],
    [' ', ''],
    ['#', ''],
    ['/', ''],
    ['.', ''],
    ['_', ''],
    ['(', ''],
    [')', ''],
    ['+', ''],
  ].reduce((sql, [from, to]) => `REPLACE(${sql}, '${from}', '${to}')`, base);
}

function addFuzzySearch(where, params, search) {
  const tokens = String(search || '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
  if (!tokens.length) return;
  const rawFields = [
    'o.order_number',
    'o.project_name',
    'o.deadline',
    'o.note',
    'c.company',
    'c.contact_name',
    'c.phone',
    'c.email',
  ];
  const compactFields = [
    'o.order_number',
    'o.project_name',
    'c.company',
    'c.contact_name',
    'c.phone',
    'c.email',
  ];
  tokens.forEach((token, index) => {
    const key = `search_${index}`;
    const normKey = `search_norm_${index}`;
    params[key] = `%${token.toLowerCase()}%`;
    const parts = rawFields.map((field) => `LOWER(COALESCE(${field}, '')) LIKE @${key}`);
    const compact = compactSearch(token);
    if (compact) {
      params[normKey] = `%${compact}%`;
      compactFields.forEach((field) => {
        parts.push(`${compactSql(field)} LIKE @${normKey}`);
      });
    }
    where.push(`(${parts.join(' OR ')})`);
  });
}

function normalizePriority(value) {
  if (value === undefined || value === null || String(value).trim() === '') return 'normal';
  const priority = String(value).trim();
  return ALLOWED_PRIORITIES.has(priority) ? priority : null;
}

function orderSummarySql(whereSql = '') {
  return `
    WITH piece_stats AS (
      SELECT
        order_id,
        COUNT(*) AS total_pieces,
        SUM(CASE WHEN stage = 'finished' THEN 1 ELSE 0 END) AS finished_pieces,
        SUM(CASE WHEN rework = 1 THEN 1 ELSE 0 END) AS rework_pieces,
        SUM(CASE WHEN broken = 1 THEN 1 ELSE 0 END) AS broken_pieces,
        SUM(CASE WHEN picked_up_at IS NOT NULL THEN 1 ELSE 0 END) AS picked_pieces
      FROM pieces
      GROUP BY order_id
    ),
    scoped_orders AS (
      SELECT
        o.*,
        c.company,
        COALESCE(ps.total_pieces, 0) AS total_pieces,
        COALESCE(ps.finished_pieces, 0) AS finished_pieces,
        COALESCE(ps.rework_pieces, 0) AS rework_pieces,
        COALESCE(ps.broken_pieces, 0) AS broken_pieces,
        COALESCE(ps.picked_pieces, 0) AS picked_pieces
      FROM orders o
      JOIN customers c ON c.id = o.customer_id
      LEFT JOIN piece_stats ps ON ps.order_id = o.id
      ${whereSql}
    )
    SELECT
      COUNT(*) AS total_orders,
      SUM(CASE WHEN status = 'in_production' THEN 1 ELSE 0 END) AS in_production_orders,
      SUM(CASE WHEN status = 'ready_pickup' THEN 1 ELSE 0 END) AS ready_pickup_orders,
      SUM(CASE WHEN status = 'picked_up' THEN 1 ELSE 0 END) AS picked_up_orders,
      SUM(CASE WHEN priority = 'rush' THEN 1 ELSE 0 END) AS rush_orders,
      SUM(CASE
        WHEN archived_at IS NULL
          AND deadline IS NOT NULL
          AND deadline < date('now', 'localtime')
          AND status NOT IN ('ready_pickup', 'picked_up')
        THEN 1 ELSE 0
      END) AS overdue_orders,
      SUM(rework_pieces) AS rework_pieces,
      SUM(CASE WHEN rework_pieces > 0 THEN 1 ELSE 0 END) AS rework_orders,
      SUM(total_pieces) AS total_pieces,
      SUM(finished_pieces) AS finished_pieces,
      SUM(picked_pieces) AS picked_pieces
    FROM scoped_orders
  `;
}

function normalizeStats(row) {
  const keys = [
    'total_orders',
    'in_production_orders',
    'ready_pickup_orders',
    'picked_up_orders',
    'rush_orders',
    'overdue_orders',
    'rework_pieces',
    'rework_orders',
    'total_pieces',
    'finished_pieces',
    'picked_pieces',
  ];
  return keys.reduce((out, key) => {
    out[key] = Number((row && row[key]) || 0);
    return out;
  }, {});
}

router.get('/stats', requireRole('boss'), (req, res) => {
  const archivedMode = queryString(req.query.archived) === '1';
  const whereSql = archivedMode ? 'WHERE o.archived_at IS NOT NULL' : 'WHERE o.archived_at IS NULL';
  const stats = normalizeStats(db.prepare(orderSummarySql(whereSql)).get());
  res.json({ stats, scope: archivedMode ? 'archive' : 'active' });
});

router.get('/', requireRole('boss'), (req, res) => {
  const page = safeInt(req.query.page, 1, 1);
  const limit = safeInt(req.query.limit, 50, 1, 100);
  const offset = (page - 1) * limit;
  const where = [];
  const params = {};
  const archivedMode = queryString(req.query.archived) === '1';
  const includeArchived = queryString(req.query.include_archived) === '1';

  if (archivedMode) {
    where.push('o.archived_at IS NOT NULL');
  } else if (!includeArchived) {
    where.push('o.archived_at IS NULL');
  }

  const status = queryString(req.query.status);
  if (status) {
    where.push('o.status = @status');
    params.status = status;
  }
  const priority = queryString(req.query.priority);
  if (priority) {
    where.push('o.priority = @priority');
    params.priority = priority;
  }
  const filter = queryString(req.query.filter);
  if (filter === 'overdue') {
    where.push("o.deadline IS NOT NULL AND o.deadline < date('now', 'localtime') AND o.status NOT IN ('ready_pickup', 'picked_up') AND o.archived_at IS NULL");
  } else if (filter === 'rework') {
    where.push(`EXISTS (
      SELECT 1
      FROM pieces rp
      WHERE rp.order_id = o.id
        AND rp.rework = 1
    )`);
  } else if (filter) {
    return res.status(400).json({ error: 'filter is invalid' });
  }
  const search = queryString(req.query.search);
  if (search) {
    addFuzzySearch(where, params, search);
  }
  const orderNumber = queryString(req.query.order_number);
  if (orderNumber) {
    where.push('o.order_number = @order_number');
    params.order_number = orderNumber;
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orders = db.prepare(`
    ${orderSelect()}
    ${whereSql}
    GROUP BY o.id
    ORDER BY o.created_at DESC, o.id DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset }).map(decorateOrder);
  const total = db.prepare(`
    SELECT COUNT(*) AS count
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    ${whereSql}
  `).get(params).count;

  res.json({ orders, page, limit, total });
});

router.get('/:id', requireRole('boss'), (req, res) => {
  const order = getOrderWithPieces(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  res.json({ order });
});

router.patch('/:id', requireRole('boss'), (req, res) => {
  const order = getOrderWithPieces(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const patch = req.body || {};
  if (patch.priority !== undefined && !ALLOWED_PRIORITIES.has(patch.priority)) {
    return res.status(400).json({ error: 'priority is invalid' });
  }
  if (patch.customer_id !== undefined) {
    const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(Number(patch.customer_id));
    if (!customer) return res.status(400).json({ error: 'customer_id is invalid' });
  }

  db.transaction(() => {
    const current = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
    const next = {
      customer_id: patch.customer_id !== undefined ? Number(patch.customer_id) : current.customer_id,
      project_name: patch.project_name !== undefined ? String(patch.project_name || '').trim() || null : current.project_name,
      priority: patch.priority !== undefined ? patch.priority : current.priority,
      deadline: patch.deadline !== undefined ? String(patch.deadline || '').trim() || null : current.deadline,
      note: patch.note !== undefined ? String(patch.note || '').trim() || null : current.note,
    };
    db.prepare(`
      UPDATE orders
      SET customer_id = @customer_id,
          project_name = @project_name,
          priority = @priority,
          deadline = @deadline,
          note = @note
      WHERE id = @id
    `).run({ ...next, id: order.id });
    insertEvent(order.id, null, req.user.id, 'order_updated', {
      fields: Object.keys(patch).filter((key) => key !== 'pieces'),
      status_at_edit: order.status,
    });

    if (Array.isArray(patch.pieces)) {
      const existing = new Map(order.pieces.map((piece) => [Number(piece.id), piece]));
      for (const piecePatch of patch.pieces) {
        const pieceId = Number(piecePatch.id);
        const piece = existing.get(pieceId);
        if (!piece) continue;
        const requiredSteps = piecePatch.required_steps !== undefined
          ? normalizeRequiredSteps(piecePatch.required_steps)
          : piece.required_steps;
        const completedSteps = piece.completed_steps.filter((step) => requiredSteps.includes(step));
        const stage = requiredSteps.find((step) => !completedSteps.includes(step)) || 'finished';
        db.prepare(`
          UPDATE pieces
          SET size = @size,
              type = @type,
              thickness = @thickness,
              weight = @weight,
              piece_note = @piece_note,
              process_config = @process_config,
              completed_steps = @completed_steps,
              stage = @stage
          WHERE id = @id AND order_id = @order_id
        `).run({
          id: pieceId,
          order_id: order.id,
          size: piecePatch.size !== undefined ? String(piecePatch.size || '').trim() || null : piece.size,
          type: piecePatch.type !== undefined ? String(piecePatch.type || '').trim() || null : piece.type,
          thickness: piecePatch.thickness !== undefined ? String(piecePatch.thickness || '').trim() || null : piece.thickness,
          weight: piecePatch.weight !== undefined ? String(piecePatch.weight || '').trim() || null : piece.weight,
          piece_note: piecePatch.piece_note !== undefined ? String(piecePatch.piece_note || '').trim() || null : piece.piece_note,
          process_config: processConfigJSON(requiredSteps),
          completed_steps: completedStepsJSON(completedSteps),
          stage,
        });
        insertEvent(order.id, pieceId, req.user.id, 'piece_updated', {
          fields: Object.keys(piecePatch).filter((key) => key !== 'id'),
          status_at_edit: order.status,
        });
      }
    }
  })();

  res.json({ order: getOrderWithPieces(order.id) });
});

router.post('/:id/ready', requireRole('boss'), (req, res) => {
  const order = getOrderWithPieces(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'in_production') {
    return res.status(400).json({ error: 'Only in-production orders can be marked ready' });
  }
  const unfinished = order.pieces.filter((piece) => piece.stage !== 'finished');
  if (unfinished.length) {
    return res.status(400).json({ error: 'All pieces must be finished first', unfinished: unfinished.length });
  }

  db.prepare("UPDATE orders SET status = 'ready_pickup' WHERE id = ?").run(order.id);
  insertEvent(order.id, null, req.user.id, 'order_ready_pickup', { total: order.pieces.length });
  res.json({ order: getOrderWithPieces(order.id) });
});

router.post('/:id/pickup', requireRole('boss'), async (req, res, next) => {
  try {
    const order = getOrderWithPieces(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });
    if (order.status !== 'ready_pickup') {
      return res.status(400).json({ error: 'Order is not ready for pickup' });
    }

    const signerName = String(req.body.signer_name || '').trim();
    if (!signerName) return res.status(400).json({ error: 'signer_name is required' });
    const signatureBase64 = String(req.body.signature_base64 || '').trim();
    if (!signatureBase64) return res.status(400).json({ error: 'signature_base64 is required' });

    const decodedSignature = decodePngSignature(signatureBase64);
    if (decodedSignature.error) return res.status(400).json({ error: decodedSignature.error });
    const signatureBuffer = decodedSignature.buffer;

    const signatureDir = path.join(uploadsBase, 'signatures');
    const slipDir = path.join(uploadsBase, 'slips');
    fs.mkdirSync(signatureDir, { recursive: true });
    fs.mkdirSync(slipDir, { recursive: true });

    const signatureFile = `signature-${order.order_number}-${Date.now()}.png`;
    const signaturePath = path.join(signatureDir, signatureFile);
    fs.writeFileSync(signaturePath, signatureBuffer);

    const slipFile = `pickup-${order.order_number}-${Date.now()}.pdf`;
    const slipPath = path.join(slipDir, slipFile);
    await createPickupSlip({
      order,
      pieces: order.pieces,
      signerName,
      signerPhone: req.body.signer_phone || '',
      signaturePath,
      outputPath: slipPath,
    });

    const pickupInfo = db.transaction(() => {
      db.prepare(`
        INSERT INTO pickups (
          order_id, signer_name, signer_phone, signature_path, slip_pdf_path, picked_by
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        order.id,
        signerName,
        req.body.signer_phone || null,
        `/uploads/signatures/${signatureFile}`,
        `/uploads/slips/${slipFile}`,
        req.user.id,
      );
      db.prepare("UPDATE orders SET status = 'picked_up' WHERE id = ?").run(order.id);
      db.prepare(`
        UPDATE pieces
        SET picked_up_at = datetime('now'),
            pickup_batch_id = NULL
        WHERE order_id = ?
      `).run(order.id);
      insertEvent(order.id, null, req.user.id, 'order_picked_up', {
        signer_name: signerName,
        signer_phone: req.body.signer_phone || null,
        slip_pdf_path: `/uploads/slips/${slipFile}`,
      });
      return db.prepare('SELECT * FROM pickups WHERE order_id = ? ORDER BY id DESC LIMIT 1').get(order.id);
    })();

    const mailResult = sendPickupEmail({
      order,
      slipPath,
      to: order.customer_email,
    });

    res.json({
      pickup: pickupInfo,
      order: getOrderWithPieces(order.id),
      mail: mailResult,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/:id/revert-pickup', requireRole('boss'), (req, res) => {
  const order = getOrderWithPieces(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'picked_up') {
    return res.status(400).json({ error: 'Only picked-up orders can be reverted' });
  }
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 200) || null;
  const tx = db.transaction(() => {
    db.prepare(`
      UPDATE pieces
      SET picked_up_at = NULL,
          pickup_batch_id = NULL
      WHERE order_id = ?
    `).run(order.id);
    syncOrderStatusFromPieces(order.id);
    insertEvent(order.id, null, req.user.id, 'pickup_reverted', { reason });
  });
  tx();
  res.json({ ok: true, order_id: order.id });
});

router.post('/:id/send-slip', requireRole('boss'), (req, res) => {
  const order = getOrderWithPieces(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const pickup = order.pickups && order.pickups[0];
  if (!pickup) return res.status(400).json({ error: 'No pickup slip exists for this order' });
  if (!order.customer_email) return res.status(400).json({ error: 'Customer email is missing' });

  const slipPath = path.join(uploadsBase, pickup.slip_pdf_path.replace(/^\/uploads\//, ''));
  if (!fs.existsSync(slipPath)) return res.status(400).json({ error: 'Pickup slip file is missing' });
  const mail = sendPickupEmail({ order, slipPath, to: order.customer_email });
  insertEvent(order.id, null, req.user.id, 'pickup_slip_sent', {
    to: order.customer_email,
    skipped: Boolean(mail.skipped),
    reason: mail.reason || null,
  });
  res.json({ ok: true, mail });
});

router.post('/:id/archive', requireRole('boss'), (req, res) => {
  const order = getOrderWithPieces(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.archived_at) {
    return res.status(400).json({ error: 'Order is already archived' });
  }
  if (order.pickup_status !== 'picked_up') {
    return res.status(400).json({ error: 'Only fully picked-up orders can be archived' });
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE orders
      SET archived_at = datetime('now'),
          archived_by = ?
      WHERE id = ?
    `).run(req.user.id, order.id);
    insertEvent(order.id, null, req.user.id, 'order_archived', {
      status_at_archive: order.status,
    });
  })();

  res.json({ ok: true, order: getOrderWithPieces(order.id) });
});

function fail(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  throw err;
}

router.post('/', requireRole('boss'), uploadPdf, (req, res, next) => {
  const uploadedPdf = req.file ? req.file.path : null;
  let tempOutputDir = null;
  let orderInserted = false;
  try {
    if (!req.file) fail(400, 'pdf is required');
    const sourceFileHash = fileHash(req.file.path);
    const duplicate = db.prepare(`
      SELECT id, order_number FROM orders WHERE source_file_hash = ?
    `).get(sourceFileHash);
    if (duplicate) {
      silentRm(uploadedPdf);
      return res.status(409).json({
        error: 'This PDF has already been uploaded',
        order_id: duplicate.id,
        order_number: duplicate.order_number,
      });
    }

    const customerId = Number(req.body.customer_id);
    const customer = db.prepare('SELECT id FROM customers WHERE id = ?').get(customerId);
    if (!customer) fail(400, 'customer_id is invalid');
    const priority = normalizePriority(req.body.priority);
    if (!priority) fail(400, 'priority is invalid');

    const tempName = `tmp-${randomUUID()}`;
    tempOutputDir = path.join(orderUploadsDir, tempName);
    const tempPublicBase = `/uploads/orders/${tempName}`;
    let parsed;
    try {
      parsed = parsePdf(req.file.path, { outputDir: tempOutputDir, publicBase: tempPublicBase });
    } catch (err) {
      const reason = (err && err.message) ? err.message.split('\n')[0] : 'unknown error';
      fail(422, `PDF parsing failed: ${reason}`);
    }

    if (!parsed.pieces.length) fail(422, 'PDF parsing failed: no pieces found in PDF');
    if (parsed.total && parsed.total !== parsed.pieces.length) {
      fail(422, `PDF parsing failed: expected ${parsed.total} pieces but parsed ${parsed.pieces.length}`);
    }

    const orderNumber = uniqueOrderNumber(req.body.order_number || parsed.orderNumber);

    const tx = db.transaction(() => {
      const orderInfo = db.prepare(`
        INSERT INTO orders (
          order_number, customer_id, project_name, priority, status,
          deadline, pdf_path, note, created_by, source_file_hash, original_filename
        )
        VALUES (
          @order_number, @customer_id, @project_name, @priority, 'in_production',
          @deadline, @pdf_path, @note, @created_by, @source_file_hash, @original_filename
        )
      `).run({
        order_number: orderNumber,
        customer_id: customerId,
        project_name: req.body.project_name || parsed.projectName || null,
        priority,
        deadline: req.body.deadline || null,
        pdf_path: `/uploads/pdfs/${path.basename(req.file.path)}`,
        note: req.body.note || null,
        created_by: req.user.id,
        source_file_hash: sourceFileHash,
        original_filename: req.file.originalname || null,
      });
      return orderInfo.lastInsertRowid;
    });

    const orderId = tx();
    orderInserted = true;

    const orderDirName = `${safeSegment(orderNumber)}-${orderId}`;
    const finalOutputDir = path.join(orderUploadsDir, orderDirName);
    const finalPublicBase = `/uploads/orders/${orderDirName}`;

    if (fs.existsSync(finalOutputDir)) {
      silentRm(finalOutputDir);
    }
    fs.renameSync(tempOutputDir, finalOutputDir);
    tempOutputDir = null;

    const pieces = parsed.pieces.map((piece) => ({
      ...piece,
      drawing_path: piece.drawing_path.replace(tempPublicBase, finalPublicBase),
    }));

    // Optional bulk template — applied to every piece unless the parser already
    // gave the piece its own required_steps. Accepts JSON array or comma list.
    let defaultStepsOverride = null;
    if (req.body.default_required_steps) {
      let raw = req.body.default_required_steps;
      try { raw = JSON.parse(raw); } catch (e) { raw = String(raw).split(','); }
      defaultStepsOverride = normalizeRequiredSteps(raw);
    }

    const insertPieces = db.transaction(() => {
      const insertPiece = db.prepare(`
        INSERT INTO pieces (
          order_id, piece_no, stage, hold, rework, broken,
          size, type, thickness, weight, piece_note, drawing_path,
          process_config, completed_steps
        )
        VALUES (
          @order_id, @piece_no, 'cut', 0, 0, 0,
          @size, @type, @thickness, @weight, @piece_note, @drawing_path,
          @process_config, @completed_steps
        )
      `);
      for (const piece of pieces) {
        const requiredSteps = piece.required_steps
          ? normalizeRequiredSteps(piece.required_steps)
          : (defaultStepsOverride || normalizeRequiredSteps(undefined));
        insertPiece.run({
          order_id: orderId,
          piece_no: piece.piece_no,
          size: piece.size,
          type: piece.type,
          thickness: piece.thickness,
          weight: piece.weight,
          piece_note: piece.piece_note,
          drawing_path: piece.drawing_path,
          process_config: processConfigJSON(requiredSteps),
          completed_steps: '[]',
        });
      }
      insertEvent(orderId, null, req.user.id, 'order_created', {
        total: pieces.length,
        pdf: path.basename(req.file.path),
      });
    });
    insertPieces();

    const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    return res.status(201).json({ order, pieces });
  } catch (err) {
    if (!orderInserted) {
      silentRm(uploadedPdf);
      silentRm(tempOutputDir);
    }
    return next(err);
  }
});

module.exports = router;
