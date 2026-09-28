const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');

const LOGO_PATH = path.join(__dirname, '..', 'public', 'images', 'logo.jpg');
const m = n => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);

/**
 * One customer's account statement as a PDF Buffer (same look as the invoices).
 * ledger: oldest first, rows shaped like customerService.getLedger() output.
 */
function generateStatementPDF({ customer, ledger, company, asOf }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    let textX = 50;
    if (fs.existsSync(LOGO_PATH)) {
      doc.image(LOGO_PATH, 50, 45, { width: 70 });
      textX = 135;
    } else {
      doc.fontSize(20).font('Helvetica-Bold').text(company.company_name || 'Crystal Drinks', 50, 45);
    }
    doc.fontSize(10).font('Helvetica').fillColor('#555');
    let hy = 50;
    if (company.company_address) { doc.text(company.company_address, textX, hy, { width: 150 }); hy += 24; }
    if (company.company_phone) { doc.text('Phone: ' + company.company_phone, textX, hy, { width: 150 }); }
    doc.fillColor('#000');

    doc.fontSize(16).font('Helvetica-Bold').text('ACCOUNT STATEMENT', 300, 45, { width: 245, align: 'right' });
    doc.fontSize(10).font('Helvetica').text(`As of: ${asOf}`, 300, 68, { width: 245, align: 'right' });

    doc.x = 50;
    doc.moveTo(50, 130).lineTo(545, 130).strokeColor('#ccc').stroke();

    doc.fontSize(11).font('Helvetica-Bold').text('Customer:', 50, 142);
    doc.font('Helvetica').fontSize(10).text(customer.name, 50, 157);
    let cy = 170;
    if (customer.phone) { doc.text(customer.phone, 50, cy); cy += 13; }
    if (customer.address) { doc.text(customer.address, 50, cy); cy += 13; }

    // Balance box
    const owes = customer.balance > 0, credit = customer.balance < 0;
    doc.fontSize(9).font('Helvetica').fillColor('#555')
      .text(owes ? 'BALANCE DUE' : credit ? 'CREDIT BALANCE' : 'BALANCE', 380, 142, { width: 165, align: 'right' });
    doc.fontSize(20).font('Helvetica-Bold').fillColor(owes ? '#b91c1c' : '#065f46')
      .text(m(Math.abs(customer.balance)), 380, 155, { width: 165, align: 'right' });
    doc.fillColor('#000');

    let y = Math.max(cy, 190) + 15;

    const header = () => {
      doc.font('Helvetica-Bold').fontSize(9);
      doc.text('Date', 50, y, { width: 65 });
      doc.text('Details', 118, y, { width: 200 });
      doc.text('Billed', 320, y, { width: 70, align: 'right' });
      doc.text('Paid', 395, y, { width: 70, align: 'right' });
      doc.text('Balance', 470, y, { width: 75, align: 'right' });
      doc.moveTo(50, y + 14).lineTo(545, y + 14).strokeColor('#ccc').stroke();
      y += 22;
    };
    header();

    doc.font('Helvetica').fontSize(9);
    if (ledger.length === 0) {
      doc.text('Nothing recorded for this customer yet.', 50, y);
      y += 20;
    }
    ledger.forEach(e => {
      if (y > 740) { doc.addPage(); y = 50; header(); doc.font('Helvetica').fontSize(9); }
      doc.font('Helvetica').fillColor('#000');
      doc.text(e.date || '-', 50, y, { width: 65 });
      const descH = doc.heightOfString(e.description, { width: 200 });
      doc.text(e.description, 118, y, { width: 200 });
      doc.text(e.billed ? m(e.billed) : '', 320, y, { width: 70, align: 'right' });
      doc.text(e.paid ? m(e.paid) : '', 395, y, { width: 70, align: 'right' });
      doc.font('Helvetica-Bold').fillColor(e.balance > 0 ? '#b91c1c' : '#065f46')
        .text(m(e.balance), 470, y, { width: 75, align: 'right' });
      y += Math.max(descH, 11) + 7;
    });

    if (y > 720) { doc.addPage(); y = 50; }
    doc.moveTo(50, y).lineTo(545, y).strokeColor('#ccc').stroke();
    y += 10;
    const billed = ledger.reduce((s, e) => s + e.billed, 0);
    const paid = ledger.reduce((s, e) => s + e.paid, 0);
    doc.fillColor('#000').font('Helvetica-Bold').fontSize(10);
    doc.text('Totals', 118, y, { width: 200 });
    doc.text(m(billed), 320, y, { width: 70, align: 'right' });
    doc.text(m(paid), 395, y, { width: 70, align: 'right' });
    y += 30;

    doc.x = 50;
    doc.fontSize(9).font('Helvetica').fillColor('#888')
      .text(owes ? 'Please arrange payment of the balance due. Thank you for your business!' : 'Thank you for your business!', 50, y, { width: 495, align: 'center' });

    doc.end();
  });
}

module.exports = { generateStatementPDF };
