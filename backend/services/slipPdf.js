const PDFDocument = require('pdfkit');
const fs = require('fs');

function createPickupSlip({ order, pieces, signerName, signerPhone, signaturePath, outputPath }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  doc.fontSize(20).text('Pickup Slip', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12);
  doc.text(`Order: ${order.order_number}`);
  doc.text(`Customer: ${order.company}`);
  doc.text(`Project: ${order.project_name || ''}`);
  doc.text(`Pieces: ${pieces.length}`);
  doc.text(`Picked up at: ${new Date().toISOString()}`);
  doc.moveDown();

  doc.fontSize(14).text('Piece Summary');
  doc.moveDown(0.5);
  doc.fontSize(10);
  pieces.forEach((piece) => {
    doc.text(`#${piece.piece_no}  ${piece.thickness || ''} ${piece.type || ''}  ${piece.size || ''}  ${piece.weight || ''}`);
  });

  doc.moveDown();
  doc.fontSize(12).text(`Signer: ${signerName}`);
  doc.text(`Phone: ${signerPhone || ''}`);
  doc.moveDown(0.5);
  doc.text('Signature:');
  if (signaturePath && fs.existsSync(signaturePath)) {
    doc.image(signaturePath, { fit: [220, 90] });
  } else {
    doc.fontSize(10).fillColor('#555').text('No signature provided.');
    doc.fillColor('black');
  }

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}

module.exports = { createPickupSlip };
