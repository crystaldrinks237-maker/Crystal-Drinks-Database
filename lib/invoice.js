const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo.jpg');

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

    // Header - logo (falls back to text-only if the image is ever missing,
    // so a missing/renamed file never breaks invoice generation)
    let textX = 50;
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, 50, 45, { width: 70 });
      textX = 135;
    } else {
      doc.fontSize(20).font('Helvetica-Bold').text(company.company_name || 'Crystal Drinks', 50, 45);
    }
    doc.fontSize(10).font('Helvetica').fillColor('#555');
    let headerY = 50;
    if (company.company_address) { doc.text(company.company_address, textX, headerY, { width: 150 }); headerY += 24; }
    if (company.company_phone) { doc.text('Phone: ' + company.company_phone, textX, headerY, { width: 150 }); headerY += 14; }
    doc.fillColor('#000');

    doc.fontSize(16).font('Helvetica-Bold').text('DELIVERY INVOICE', 300, 45, { width: 245, align: 'right' });
    doc.fontSize(10).font('Helvetica')
      .text(`Invoice #: ${delivery.invoice_number}`, 300, 68, { width: 245, align: 'right' })
      .text(`Date: ${delivery.date}`, 300, 81, { width: 245, align: 'right' });

    doc.fontSize(11).font('Helvetica-Bold')
      .fillColor(isAdmin ? '#b91c1c' : '#065f46')
      .text(isAdmin ? 'OFFICE / ADMIN COPY' : 'CLIENT COPY', 300, 96, { width: 245, align: 'right' });
    doc.fillColor('#000');

    doc.x = 50; // header text above was placed at other x positions - go back to the left margin
    doc.y = 130;
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
    doc.text('Qty', 255, tableTop, { width: 115, align: 'right' });
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
      // Rows sold by the crate ("pet" of 6) show pets first, with the bottle count
      // alongside, and the price per pet - matching how the price was actually agreed,
      // rather than the divided-out per-bottle figure.
      const qtyText = item.crates
        ? `${item.crates} pet${item.crates === 1 ? '' : 's'} (${item.quantity})`
        : String(item.quantity);
      const priceText = item.crates
        ? Number(item.price_per_crate).toFixed(2) + '/pet'
        : Number(item.price_per_bottle).toFixed(2);
      doc.text(desc, 50, y, { width: 195 });
      doc.text(qtyText, 255, y, { width: 115, align: 'right' });
      doc.text(priceText, 375, y, { width: 80, align: 'right' });
      doc.text(Number(item.subtotal).toFixed(2), 460, y, { width: 85, align: 'right' });
      y += 20;
    });

    doc.moveTo(50, y + 5).lineTo(545, y + 5).strokeColor('#ccc').stroke();

    const totalAmount = Number(delivery.total_amount) || 0;
    const previousBalance = Number(delivery.previous_balance) || 0;
    const amountPaid = Number(delivery.amount_paid) || 0;
    // Deliveries for a tracked (regular) customer get the full account summary.
    // One-time customers and deliveries from before customer tracking existed
    // keep the plain "Total" line, exactly as they always looked.
    const showAccountSummary = !!delivery.customer_id || previousBalance !== 0;

    if (!showAccountSummary) {
      doc.font('Helvetica-Bold').fontSize(12);
      doc.text('Total: ' + totalAmount.toFixed(2), 380, y + 15, { width: 165, align: 'right' });
      doc.y = y + 45;
    } else {
      const round2 = n => Math.round(n * 100) / 100;
      const totalPayable = round2(previousBalance + totalAmount);
      const balanceDue = round2(totalPayable - amountPaid);

      // Keep the whole summary together on one page
      let sy = y + 18;
      if (sy + 130 > 780) { doc.addPage(); sy = 50; }

      const LABEL_X = 290, LABEL_W = 170, VALUE_X = 465, VALUE_W = 80;
      const row = (label, value, { bold = false, color = '#000', size = 10 } = {}) => {
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
        doc.text(label, LABEL_X, sy, { width: LABEL_W, align: 'right' });
        doc.text(value, VALUE_X, sy, { width: VALUE_W, align: 'right' });
        sy += size + 6;
      };
      const rule = () => {
        doc.moveTo(LABEL_X, sy).lineTo(545, sy).strokeColor('#ccc').stroke();
        sy += 6;
      };

      row('This delivery', totalAmount.toFixed(2));
      if (previousBalance !== 0) {
        row(previousBalance > 0 ? 'Previous balance (unpaid)' : 'Credit from earlier payments', previousBalance.toFixed(2));
        rule();
        row('Total payable', totalPayable.toFixed(2), { bold: true, size: 11 });
      }
      if (amountPaid > 0) {
        row('Paid now', '- ' + amountPaid.toFixed(2));
      }
      rule();
      if (balanceDue > 0) {
        row('BALANCE DUE', balanceDue.toFixed(2), { bold: true, size: 13, color: '#b91c1c' });
      } else if (balanceDue < 0) {
        row('Credit balance (we owe you)', (-balanceDue).toFixed(2), { bold: true, size: 11, color: '#065f46' });
      } else {
        row('Balance due', '0.00', { bold: true, size: 12 });
        row('PAID IN FULL', '', { bold: true, size: 11, color: '#065f46' });
      }
      doc.fillColor('#000');
      doc.y = sy + 15;
    }

    doc.x = 50;

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
      const margin = totalAmount - Number(delivery.petrol_cost || 0);
      doc.text(`Revenue minus petrol cost: ${margin.toFixed(2)}`);
    }

    doc.moveDown(3);
    doc.fontSize(9).fillColor('#888')
      .text(isAdmin ? 'Office copy - kept for internal records.' : 'Thank you for your business!', { align: 'center' });

    doc.end();
  });
}

module.exports = { generateInvoicePDF };
