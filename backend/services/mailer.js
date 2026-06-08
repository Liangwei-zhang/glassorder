const nodemailer = require('nodemailer');

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function poLabel(value) {
  const code = String(value || '').trim();
  if (!code) return 'PO';
  return /^PO\b/i.test(code) ? code : `PO ${code}`;
}

function safeAttachmentName(value) {
  return String(value || 'po')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'po';
}

function sendPickupEmail({ order, slipPath, to, cc }) {
  if (!smtpConfigured() || !to) {
    return { skipped: true, reason: !to ? 'no customer email' : 'smtp not configured', cc: cc || null };
  }
  const po = poLabel(order.order_number);

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
    cc: cc || undefined,
    subject: `Pickup slip for ${po}`,
    text: `Attached is the pickup slip for ${po}.`,
    attachments: [{ filename: `pickup-${safeAttachmentName(order.order_number)}.pdf`, path: slipPath }],
  }).catch((err) => {
    console.error('Pickup email failed:', err.message);
  });

  return { skipped: false, cc: cc || null };
}

module.exports = { sendPickupEmail };
