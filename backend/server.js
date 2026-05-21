require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const path = require('path');
require('./db');

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
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.get('/api/health', (req, res) => {
  res.json({ ok: true });
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
