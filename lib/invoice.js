const PDFDocument = require('pdfkit');

/**
 * Builds a PDF invoice and resolves with a Buffer (rather than piping
 * directly to an HTTP response). Buffering lets the caller send an accurate
 * Content-Length header, which mobile Safari in particular needs to reliably
 * open/download a PDF - without it, chunked PDF responses often just fail
 * silently on iPhone with no visible error.
 *
 * items: array of { type_name, quality_name, quantity, price_per_bottle, subtotal }
 * copyType: 'client' or 'admin'
 */
function generateInvoicePDF({ delivery, items, company, copyType }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const isAdmin = copyType === 'admin';

    // Header
    doc.fontSize(20).font('Helvetica-Bold').text(company.company_name || 'Crystal Drinks', { align: 'left' });
    doc.fontSize(10).font('Helvetica').fillColor('#555');
    if (company.company_address) doc.text(company.company_address);
    if (company.company_phone) doc.text('Phone: ' + company.company_phone);
    doc.moveDown(1);

    doc.fillColor('#000');
    doc.fontSize(16).font('Helvetica-Bold').text('DELIVERY INVOICE', { align: 'right' });
    doc.fontSize(10).font('Helvetica')
      .text(`Invoice #: ${delivery.invoice_number}`, { align: 'right' })
      .text(`Date: ${delivery.date}`, { align: 'right' });

    doc.fontSize(11).font('Helvetica-Bold')
      .fillColor(isAdmin ? '#b91c1c' : '#065f46')
      .text(isAdmin ? 'OFFICE / ADMIN COPY' : 'CLIENT COPY', { align: 'right' });
    doc.fillColor('#000');

    doc.moveDown(1.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
    doc.moveDown(1);

    // Bill To
    doc.fontSize(11).font('Helvetica-Bold').text('Delivered To:');
    doc.font('Helvetica').fontSize(10);
    doc.text(delivery.client_name || '-');
    if (delivery.destination) doc.text(delivery.destination);
    doc.moveDown(1.5);

    // Table header
    const tableTop = doc.y;
    doc.font('Helvetica-Bold').fontSize(10);
    doc.text('Bottle (type / quality)', 50, tableTop);
    doc.text('Qty', 280, tableTop, { width: 90, align: 'right' });
    doc.text('Unit Price', 375, tableTop, { width: 80, align: 'right' });
    doc.text('Amount', 460, tableTop, { width: 85, align: 'right' });
    doc.moveTo(50, tableTop + 15).lineTo(545, tableTop + 15).strokeColor('#ccc').stroke();

    let y = tableTop + 25;
    doc.font('Helvetica').fontSize(10);
    const lineItems = (items && items.length > 0)
      ? items
      : [{ type_name: 'Premium bottled water', quality_name: '', quantity: delivery.bottles_count, price_per_bottle: delivery.price_per_bottle, subtotal: delivery.total_amount }];

    lineItems.forEach(item => {
      if (y > 700) { doc.addPage(); y = 50; }
      const desc = item.quality_name ? `${item.type_name} / ${item.quality_name}` : item.type_name;
      doc.text(desc, 50, y, { width: 220 });
      doc.text(String(item.quantity), 280, y, { width: 90, align: 'right' });
      doc.text(Number(item.price_per_bottle).toFixed(2), 375, y, { width: 80, align: 'right' });
      doc.text(Number(item.subtotal).toFixed(2), 460, y, { width: 85, align: 'right' });
      y += 20;
    });

    doc.moveTo(50, y + 5).lineTo(545, y + 5).strokeColor('#ccc').stroke();

    doc.font('Helvetica-Bold').fontSize(12);
    doc.text('Total: ' + delivery.total_amount.toFixed(2), 380, y + 15, { width: 165, align: 'right' });

    doc.y = y + 45;

    if (delivery.notes) {
      doc.moveDown(1.5);
      doc.font('Helvetica-Bold').fontSize(10).text('Notes:');
      doc.font('Helvetica').fontSize(10).text(delivery.notes);
    }

    // Admin-only internal cost section
    if (isAdmin) {
      doc.moveDown(2);
      doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
      doc.moveDown(0.5);
      doc.font('Helvetica-Bold').fontSize(11).fillColor('#b91c1c').text('Internal reference (not for client)');
      doc.fillColor('#000').font('Helvetica').fontSize(10);
      doc.text(`Petrol cost for this trip: ${Number(delivery.petrol_cost || 0).toFixed(2)}`);
      const margin = delivery.total_amount - Number(delivery.petrol_cost || 0);
      doc.text(`Revenue minus petrol cost: ${margin.toFixed(2)}`);
    }

    doc.moveDown(3);
    doc.fontSize(9).fillColor('#888')
      .text(isAdmin ? 'Office copy - kept for internal records.' : 'Thank you for your business!', { align: 'center' });

    doc.end();
  });
}

module.exports = { generateInvoicePDF };
