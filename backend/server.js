const express = require('express');
const fs = require('fs');
const helmet = require('helmet');
const path = require('path');

require('dotenv').config({
  path: process.env.ENV_FILE || path.join(__dirname, '.env'),
});

const db = require('./db');
const { authenticate } = require('./middleware/auth');

const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customers');
const orderRoutes = require('./routes/orders');
const pieceRoutes = require('./routes/pieces');
const pickupRoutes = require('./routes/pickups');
const summaryRoutes = require('./routes/summary');

const app = express();
const port = Number(process.env.PORT || 8781);
const frontendDir = path.join(__dirname, '..', 'frontend');

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true }));

const uploadsDir = db.runtime && db.runtime.uploadsBase
  ? db.runtime.uploadsBase
  : path.join(__dirname, 'uploads');
app.use('/uploads', authenticate, (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  let rel = decodeURIComponent(String(req.url || '').split('?')[0].replace(/^\/+/, '')).replace(/\\/g, '/');
  if (rel.startsWith('uploads/')) rel = rel.slice('uploads/'.length);
  if (!rel) return res.status(404).json({ error: 'File not found' });
  if (req.user.role !== 'boss' && !rel.startsWith('orders/')) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const filePath = path.resolve(uploadsDir, rel);
  const root = path.resolve(uploadsDir);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    return res.status(404).json({ error: 'File not found' });
  }
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (err) {
    return res.status(404).json({ error: 'File not found' });
  }
  if (!stat.isFile()) return res.status(404).json({ error: 'File not found' });

  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Content-Length', stat.size);
  res.type(path.extname(filePath));
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'File unavailable' });
    else res.destroy();
  });
  return stream.pipe(res);
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/customers', customerRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/pieces', pieceRoutes);
app.use('/api/pickups', pickupRoutes);
app.use('/api/summary', summaryRoutes);

app.use(express.static(frontendDir, {
  setHeaders(res, filePath) {
    if (/sw\.js$/i.test(filePath) || /manifest\.json$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    } else if (/\.(css|js|png|jpg|svg|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=3600, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.get('/', (req, res) => {
  res.sendFile(path.join(frontendDir, 'login.html'));
});

app.use((err, req, res, next) => {
  if (!err.expose) console.error(err);
  const status = err.status || 500;
  const message = err.expose || status < 500 ? err.message : 'Internal server error';
  res.status(status).json({ error: message || 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Glass Order listening on http://localhost:${port}`);
});
