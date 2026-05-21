const express = require('express');
const db = require('../db');
const { authenticate, requireRole } = require('../middleware/auth');
const { decorateOrder } = require('../services/orderStatus');

const router = express.Router();
router.use(authenticate);
router.use(requireRole('boss'));

router.get('/overview', (req, res) => {
  const statusRows = db.prepare(`
    SELECT
      o.status,
      COUNT(DISTINCT o.id) AS orders,
      COUNT(p.id) AS pieces,
      SUM(CASE WHEN p.stage = 'finished' THEN 1 ELSE 0 END) AS finished_pieces,
      SUM(CASE WHEN p.picked_up_at IS NOT NULL THEN 1 ELSE 0 END) AS picked_pieces,
      SUM(CASE WHEN p.hold = 1 THEN 1 ELSE 0 END) AS hold_pieces,
      SUM(CASE WHEN p.rework = 1 THEN 1 ELSE 0 END) AS rework_pieces,
      SUM(CASE WHEN p.broken = 1 THEN 1 ELSE 0 END) AS broken_pieces
    FROM orders o
    LEFT JOIN pieces p ON p.order_id = o.id
    WHERE o.archived_at IS NULL
    GROUP BY o.status
    ORDER BY o.status
  `).all();

  const customerRows = db.prepare(`
    SELECT
      c.id AS customer_id,
      c.company,
      COUNT(DISTINCT o.id) AS orders,
      COUNT(p.id) AS pieces,
      SUM(CASE WHEN p.stage = 'finished' THEN 1 ELSE 0 END) AS finished_pieces,
      SUM(CASE WHEN p.picked_up_at IS NOT NULL THEN 1 ELSE 0 END) AS picked_pieces,
      SUM(CASE WHEN p.hold = 1 THEN 1 ELSE 0 END) AS hold_pieces,
      SUM(CASE WHEN p.rework = 1 THEN 1 ELSE 0 END) AS rework_pieces,
      SUM(CASE WHEN p.broken = 1 THEN 1 ELSE 0 END) AS broken_pieces
    FROM customers c
    JOIN orders o ON o.customer_id = c.id
    LEFT JOIN pieces p ON p.order_id = o.id
    WHERE o.archived_at IS NULL
    GROUP BY c.id
    ORDER BY c.company COLLATE NOCASE
  `).all();

  const totals = db.prepare(`
    SELECT
      COUNT(DISTINCT o.id) AS orders,
      COUNT(p.id) AS pieces,
      SUM(CASE WHEN p.stage = 'finished' THEN 1 ELSE 0 END) AS finished_pieces,
      SUM(CASE WHEN p.picked_up_at IS NOT NULL THEN 1 ELSE 0 END) AS picked_pieces,
      SUM(CASE WHEN p.hold = 1 THEN 1 ELSE 0 END) AS hold_pieces,
      SUM(CASE WHEN p.rework = 1 THEN 1 ELSE 0 END) AS rework_pieces,
      SUM(CASE WHEN p.broken = 1 THEN 1 ELSE 0 END) AS broken_pieces
    FROM orders o
    LEFT JOIN pieces p ON p.order_id = o.id
    WHERE o.archived_at IS NULL
  `).get();

  res.json({ totals, by_status: statusRows, by_customer: customerRows });
});

router.get('/customers/:id', (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const orders = db.prepare(`
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
    WHERE o.customer_id = ?
    GROUP BY o.id
    ORDER BY o.created_at DESC, o.id DESC
  `).all(customer.id).map(decorateOrder);

  const batches = db.prepare(`
    SELECT
      b.*,
      COUNT(pi.id) AS total_items,
      SUM(CASE WHEN pi.reverted_at IS NULL THEN 1 ELSE 0 END) AS active_items,
      SUM(CASE WHEN pi.reverted_at IS NOT NULL THEN 1 ELSE 0 END) AS reverted_items
    FROM pickup_batches b
    LEFT JOIN pickup_items pi ON pi.batch_id = b.id
    WHERE b.customer_id = ?
    GROUP BY b.id
    ORDER BY b.picked_at DESC, b.id DESC
  `).all(customer.id);

  res.json({ customer, orders, batches });
});

module.exports = router;
