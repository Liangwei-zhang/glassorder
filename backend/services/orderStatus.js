const db = require('../db');

function numeric(value) {
  return Number(value || 0);
}

function derivePickupStatus(row) {
  const total = numeric(row.total_pieces);
  const finished = numeric(row.finished_pieces);
  const picked = numeric(row.picked_pieces);
  if (total > 0 && picked >= total) return 'picked_up';
  if (picked > 0) return 'partial';
  if (total > 0 && finished >= total) return 'ready';
  return 'not_ready';
}

function decorateOrder(row) {
  if (!row) return row;
  return {
    ...row,
    total_pieces: numeric(row.total_pieces),
    finished_pieces: numeric(row.finished_pieces),
    rework_pieces: numeric(row.rework_pieces),
    broken_pieces: numeric(row.broken_pieces),
    picked_pieces: numeric(row.picked_pieces),
    unpicked_pieces: Math.max(0, numeric(row.total_pieces) - numeric(row.picked_pieces)),
    pickup_status: derivePickupStatus(row),
  };
}

function pickupStatsForOrder(orderId) {
  return db.prepare(`
    SELECT
      COUNT(*) AS total_pieces,
      SUM(CASE WHEN stage = 'finished' THEN 1 ELSE 0 END) AS finished_pieces,
      SUM(CASE WHEN picked_up_at IS NOT NULL THEN 1 ELSE 0 END) AS picked_pieces
    FROM pieces
    WHERE order_id = ?
  `).get(orderId);
}

function syncOrderStatusFromPieces(orderId) {
  const stats = pickupStatsForOrder(orderId);
  const total = numeric(stats.total_pieces);
  const finished = numeric(stats.finished_pieces);
  const picked = numeric(stats.picked_pieces);
  let status = 'in_production';
  if (total > 0 && picked >= total) status = 'picked_up';
  else if (total > 0 && finished >= total) status = 'ready_pickup';
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, orderId);
  return { ...stats, status, pickup_status: derivePickupStatus(stats) };
}

module.exports = {
  decorateOrder,
  derivePickupStatus,
  pickupStatsForOrder,
  syncOrderStatusFromPieces,
};
