const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const {
  DISPLAY_STAGES,
  advancePieceState,
  completedStepsJSON,
  hydratePieceWorkflow,
  normalizeRequiredSteps,
  processConfigJSON,
  redoPieceState,
  returnPreviousPieceState,
  sendPieceToPolishState,
} = require('../services/pieceWorkflow');
const { syncOrderStatusFromPieces } = require('../services/orderStatus');

const router = express.Router();
const STAGES = DISPLAY_STAGES;

router.use(authenticate);

function boolRow(row) {
  if (!row) return row;
  return hydratePieceWorkflow({
    ...row,
    hold: Boolean(row.hold),
    rework: Boolean(row.rework),
    broken: Boolean(row.broken),
  });
}

function insertEvent(orderId, pieceId, actorId, action, details) {
  db.prepare(`
    INSERT INTO events (order_id, piece_id, actor_id, action, details)
    VALUES (?, ?, ?, ?, ?)
  `).run(orderId, pieceId || null, actorId || null, action, details ? JSON.stringify(details) : null);
}

function getPiece(id) {
  return db.prepare(`
    SELECT p.*, o.order_number, o.status AS order_status
    FROM pieces p
    JOIN orders o ON o.id = p.order_id
    WHERE p.id = ?
  `).get(id);
}

function body(req) {
  return req.body || {};
}

function pieceLockedForCorrection(piece) {
  if (piece.picked_up_at) return 'Picked up pieces cannot be changed';
  if (piece.hold) return 'Piece is on hold';
  return '';
}

router.get('/', requireRole('boss', 'worker'), (req, res) => {
  const where = [];
  const params = {};
  if (req.query.stage) {
    where.push('p.stage = @stage');
    params.stage = req.query.stage;
  }
  if (req.query.order_id) {
    where.push('p.order_id = @order_id');
    params.order_id = Number(req.query.order_id);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pieces = db.prepare(`
    SELECT p.*, o.order_number, o.status AS order_status, c.company, o.project_name, o.priority
    FROM pieces p
    JOIN orders o ON o.id = p.order_id
    JOIN customers c ON c.id = o.customer_id
    ${whereSql}
    ORDER BY o.deadline IS NULL, o.deadline, o.created_at, p.piece_no
  `).all(params).map(boolRow);
  const out = { pieces };
  if (req.query.include_rework === '1' || req.query.include_rework === 'true') {
    out.rework = db.prepare(`
      SELECT p.*, o.order_number, o.status AS order_status, c.company, o.project_name, o.priority
      FROM pieces p
      JOIN orders o ON o.id = p.order_id
      JOIN customers c ON c.id = o.customer_id
      WHERE p.rework = 1 AND o.status != 'picked_up'
      ORDER BY o.deadline IS NULL, o.deadline, o.created_at, p.piece_no
    `).all().map(boolRow);
  }
  res.json(out);
});

router.post('/:id/advance', requireRole('boss', 'worker'), (req, res) => {
  const piece = boolRow(getPiece(req.params.id));
  if (!piece) return res.status(404).json({ error: 'Piece not found' });
  if (piece.hold) return res.status(400).json({ error: 'Piece is on hold' });

  const next = advancePieceState(piece);

  db.prepare(`
    UPDATE pieces
    SET stage = ?, completed_steps = ?, rework = 0, broken = 0
    WHERE id = ?
  `).run(next.stage, completedStepsJSON(next.completed_steps), piece.id);
  insertEvent(piece.order_id, piece.id, req.user.id, 'piece_advanced', {
    from: piece.stage,
    to: next.stage,
    completed_steps: next.completed_steps,
  });
  res.json({ piece: boolRow(getPiece(piece.id)) });
});

router.post('/:id/broken', requireRole('boss', 'worker'), (req, res) => {
  const piece = getPiece(req.params.id);
  if (!piece) return res.status(404).json({ error: 'Piece not found' });

  db.prepare(`
    UPDATE pieces
    SET stage = 'cut', completed_steps = '[]', rework = 1, broken = 1, hold = 0
    WHERE id = ?
  `).run(piece.id);
  insertEvent(piece.order_id, piece.id, req.user.id, 'piece_broken', {
    from: piece.stage,
    note: body(req).note || null,
  });
  syncOrderStatusFromPieces(piece.order_id);
  res.json({ piece: boolRow(getPiece(piece.id)) });
});

router.post('/:id/send-polish', requireRole('boss', 'worker'), (req, res) => {
  const piece = boolRow(getPiece(req.params.id));
  if (!piece) return res.status(404).json({ error: 'Piece not found' });
  const locked = pieceLockedForCorrection(piece);
  if (locked) return res.status(400).json({ error: locked });

  const next = sendPieceToPolishState(piece);
  if (!next) {
    return res.status(400).json({ error: 'Piece must complete tempering before polishing' });
  }

  db.prepare(`
    UPDATE pieces
    SET stage = 'polish',
        process_config = ?,
        completed_steps = ?,
        broken = 0
    WHERE id = ?
  `).run(
    processConfigJSON(next.required_steps),
    completedStepsJSON(next.completed_steps),
    piece.id,
  );
  insertEvent(piece.order_id, piece.id, req.user.id, 'piece_sent_to_polish', {
    from: piece.stage,
    to: 'polish',
    required_steps: next.required_steps,
    note: body(req).note || null,
  });
  syncOrderStatusFromPieces(piece.order_id);
  res.json({ piece: boolRow(getPiece(piece.id)) });
});

router.post('/:id/return-previous', requireRole('boss', 'worker'), (req, res) => {
  const piece = boolRow(getPiece(req.params.id));
  if (!piece) return res.status(404).json({ error: 'Piece not found' });
  const locked = pieceLockedForCorrection(piece);
  if (locked) return res.status(400).json({ error: locked });

  const next = returnPreviousPieceState(piece);
  if (!next) return res.status(400).json({ error: 'Piece is already at the first step' });

  db.prepare(`
    UPDATE pieces
    SET stage = ?,
        completed_steps = ?,
        broken = 0
    WHERE id = ?
  `).run(next.stage, completedStepsJSON(next.completed_steps), piece.id);
  insertEvent(piece.order_id, piece.id, req.user.id, 'piece_returned_previous', {
    from: piece.stage,
    to: next.stage,
    completed_steps: next.completed_steps,
    note: body(req).note || null,
  });
  syncOrderStatusFromPieces(piece.order_id);
  res.json({ piece: boolRow(getPiece(piece.id)) });
});

router.post('/:id/redo', requireRole('boss', 'worker'), (req, res) => {
  const piece = boolRow(getPiece(req.params.id));
  if (!piece) return res.status(404).json({ error: 'Piece not found' });
  const locked = pieceLockedForCorrection(piece);
  if (locked) return res.status(400).json({ error: locked });

  const next = redoPieceState(piece);
  db.prepare(`
    UPDATE pieces
    SET stage = 'cut',
        completed_steps = ?,
        rework = 1,
        broken = 0,
        hold = 0
    WHERE id = ?
  `).run(completedStepsJSON(next.completed_steps), piece.id);
  insertEvent(piece.order_id, piece.id, req.user.id, 'piece_redo', {
    from: piece.stage,
    to: 'cut',
    note: body(req).note || null,
  });
  syncOrderStatusFromPieces(piece.order_id);
  res.json({ piece: boolRow(getPiece(piece.id)) });
});

router.post('/:id/hold', requireRole('boss', 'worker'), (req, res) => {
  const piece = getPiece(req.params.id);
  if (!piece) return res.status(404).json({ error: 'Piece not found' });
  db.prepare('UPDATE pieces SET hold = 1 WHERE id = ?').run(piece.id);
  insertEvent(piece.order_id, piece.id, req.user.id, 'piece_hold', { note: body(req).note || null });
  res.json({ piece: boolRow(getPiece(piece.id)) });
});

router.post('/:id/unhold', requireRole('boss', 'worker'), (req, res) => {
  const piece = getPiece(req.params.id);
  if (!piece) return res.status(404).json({ error: 'Piece not found' });
  db.prepare('UPDATE pieces SET hold = 0 WHERE id = ?').run(piece.id);
  insertEvent(piece.order_id, piece.id, req.user.id, 'piece_unhold', { note: body(req).note || null });
  res.json({ piece: boolRow(getPiece(piece.id)) });
});

router.patch('/:id/process-config', requireRole('boss', 'worker'), (req, res) => {
  const piece = boolRow(getPiece(req.params.id));
  if (!piece) return res.status(404).json({ error: 'Piece not found' });

  const requiredSteps = normalizeRequiredSteps(body(req).required_steps);
  const completedSteps = piece.completed_steps.filter((step) => requiredSteps.includes(step));
  const nextStage = requiredSteps.find((step) => !completedSteps.includes(step)) || 'finished';
  db.prepare(`
    UPDATE pieces
    SET process_config = ?, completed_steps = ?, stage = ?
    WHERE id = ?
  `).run(
    processConfigJSON(requiredSteps),
    completedStepsJSON(completedSteps),
    nextStage,
    piece.id,
  );
  insertEvent(piece.order_id, piece.id, req.user.id, 'piece_process_config_updated', {
    required_steps: requiredSteps,
  });
  res.json({ piece: boolRow(getPiece(piece.id)) });
});

router.post('/batch', requireRole('boss', 'worker'), (req, res) => {
  const reqBody = body(req);
  const ids = Array.isArray(reqBody.piece_ids)
    ? reqBody.piece_ids.map(Number).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  const action = String(reqBody.action || '').trim();
  if (!ids.length) return res.status(400).json({ error: 'piece_ids are required' });
  if (!['advance', 'complete', 'hold', 'unhold', 'broken', 'set_process_config'].includes(action)) {
    return res.status(400).json({ error: 'Unsupported batch action' });
  }

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT p.*, o.order_number, o.status AS order_status
    FROM pieces p
    JOIN orders o ON o.id = p.order_id
    WHERE p.id IN (${placeholders})
    ORDER BY p.order_id, p.piece_no
  `).all(...ids).map(boolRow);
  if (rows.length !== new Set(ids).size) {
    return res.status(404).json({ error: 'Some pieces were not found' });
  }

  const updatedIds = db.transaction(() => {
    const out = [];
    for (const piece of rows) {
      if (action === 'advance' || action === 'complete') {
        if (piece.hold) {
          insertEvent(piece.order_id, piece.id, req.user.id, 'piece_batch_skipped', {
            reason: 'hold',
            action,
          });
          continue;
        }
        const next = advancePieceState(piece, { completeAll: action === 'complete' });
        db.prepare(`
          UPDATE pieces
          SET stage = ?, completed_steps = ?, rework = 0, broken = 0
          WHERE id = ?
        `).run(next.stage, completedStepsJSON(next.completed_steps), piece.id);
        insertEvent(piece.order_id, piece.id, req.user.id, 'piece_batch_advanced', {
          action,
          from: piece.stage,
          to: next.stage,
          completed_steps: next.completed_steps,
        });
      } else if (action === 'hold') {
        db.prepare('UPDATE pieces SET hold = 1 WHERE id = ?').run(piece.id);
        insertEvent(piece.order_id, piece.id, req.user.id, 'piece_hold', { batch: true });
      } else if (action === 'unhold') {
        db.prepare('UPDATE pieces SET hold = 0 WHERE id = ?').run(piece.id);
        insertEvent(piece.order_id, piece.id, req.user.id, 'piece_unhold', { batch: true });
      } else if (action === 'broken') {
        db.prepare(`
          UPDATE pieces
          SET stage = 'cut', completed_steps = '[]', rework = 1, broken = 1, hold = 0
          WHERE id = ?
        `).run(piece.id);
        insertEvent(piece.order_id, piece.id, req.user.id, 'piece_broken', {
          batch: true,
          from: piece.stage,
          note: reqBody.note || null,
        });
      } else if (action === 'set_process_config') {
        const requiredSteps = normalizeRequiredSteps(reqBody.required_steps);
        const completedSteps = piece.completed_steps.filter((step) => requiredSteps.includes(step));
        const nextStage = requiredSteps.find((step) => !completedSteps.includes(step)) || 'finished';
        db.prepare(`
          UPDATE pieces
          SET process_config = ?, completed_steps = ?, stage = ?
          WHERE id = ?
        `).run(
          processConfigJSON(requiredSteps),
          completedStepsJSON(completedSteps),
          nextStage,
          piece.id,
        );
        insertEvent(piece.order_id, piece.id, req.user.id, 'piece_process_config_updated', {
          batch: true,
          required_steps: requiredSteps,
        });
      }
      out.push(piece.id);
    }
    return out;
  })();

  if (!updatedIds.length) {
    return res.json({ pieces: [], skipped: rows.length });
  }
  const updatedPlaceholders = updatedIds.map(() => '?').join(',');
  const pieces = db.prepare(`
    SELECT p.*, o.order_number, o.status AS order_status
    FROM pieces p
    JOIN orders o ON o.id = p.order_id
    WHERE p.id IN (${updatedPlaceholders})
    ORDER BY p.order_id, p.piece_no
  `).all(...updatedIds).map(boolRow);
  res.json({ pieces, updated: pieces.length, skipped: rows.length - pieces.length });
});

module.exports = router;
