const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function decodePngSignature(signatureBase64) {
  const raw = String(signatureBase64 || '').trim();
  if (!raw) return { error: 'signature_base64 is required' };

  const base64 = raw.replace(/^data:image\/png;base64,/i, '').replace(/\s+/g, '');
  if (!base64 || base64.length < 32 || base64.length % 4 === 1 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return { error: 'signature_base64 is invalid' };
  }

  const buffer = Buffer.from(base64, 'base64');
  const normalizedInput = base64.replace(/=+$/g, '');
  const normalizedOutput = buffer.toString('base64').replace(/=+$/g, '');
  if (!buffer.length || normalizedInput !== normalizedOutput) {
    return { error: 'signature_base64 is invalid' };
  }

  if (buffer.length < 24 || !buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { error: 'signature_base64 is invalid' };
  }
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') {
    return { error: 'signature_base64 is invalid' };
  }

  return { buffer };
}

function decodeOptionalPngSignature(signatureBase64) {
  const raw = String(signatureBase64 || '').trim();
  if (!raw) return { buffer: null };
  return decodePngSignature(raw);
}

module.exports = { decodePngSignature, decodeOptionalPngSignature };
