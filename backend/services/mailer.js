const nodemailer = require('nodemailer');

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function sendPickupEmail({ order, slipPath, to }) {
  if (!smtpConfigured() || !to) {
    return { skipped: true, reason: !to ? 'no customer email' : 'smtp not configured' };
  }

  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  transporter.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject: `Pickup slip for order ${order.order_number}`,
    text: `Attached is the pickup slip for order ${order.order_number}.`,
    attachments: [{ filename: `pickup-${order.order_number}.pdf`, path: slipPath }],
  }).catch((err) => {
    console.error('Pickup email failed:', err.message);
  });

  return { skipped: false };
}

module.exports = { sendPickupEmail };
