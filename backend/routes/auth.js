const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { JWT_SECRET } = require('../middleware/auth');

const router = express.Router();

const LOGIN_LIMIT_DISABLED = process.env.DISABLE_LOGIN_RATE_LIMIT === '1';
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a minute.' },
  skipSuccessfulRequests: true,
  skip: () => LOGIN_LIMIT_DISABLED,
});

router.post('/login', loginLimiter, (req, res) => {
  const { login, password } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'login and password are required' });
  }

  const user = db.prepare(`
    SELECT id, phone, email, password_hash, name, role
    FROM users
    WHERE phone = ? OR email = ?
  `).get(login, login);

  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const publicUser = {
    id: user.id,
    phone: user.phone,
    email: user.email,
    name: user.name,
    role: user.role,
  };
  const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  return res.json({ token, user: publicUser });
});

module.exports = router;
