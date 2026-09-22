const PDFDocument = require('pdfkit');

function money(n) { return Number(n || 0).toFixed(0); }

function generateMonthlyReportPDF({ stream, company, monthLabel, data }) {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(stream);

  doc.fontSize(20).font('Helvetica-Bold').text(company.company_name || 'Crystal Drinks');
  doc.fontSize(10).font('Helvetica').fillColor('#555');
  if (company.company_address) doc.text(company.company_address);
  doc.moveDown(0.5);
  doc.fillColor('#000').fontSize(16).font('Helvetica-Bold').text(`Monthly Summary — ${monthLabel}`);
  doc.moveDown(1);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
  doc.moveDown(1);

  // Financial summary
  doc.font('Helvetica-Bold').fontSize(13).text('Financial summary');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10);
  const rows = [
    ['Revenue from deliveries', money(data.revenue)],
    ['Wages paid', money(data.wages)],
    ['Bottle purchases', money(data.bottleCost)],
    ['Petrol', money(data.petrol)],
    ['Vehicle maintenance', money(data.maintenance)],
    ['Electricity', money(data.electricity)],
    ['Other expenses', money(data.otherExpenses)],
  ];
  rows.forEach(([label, val]) => {
    doc.text(label, 50, doc.y, { continued: true, width: 350 });
    doc.text(val, { align: 'right' });
  });
  doc.moveDown(0.3);
  doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#ccc').stroke();
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold');
  const totalExpenses = data.wages + data.bottleCost + data.petrol + data.maintenance + data.otherExpenses;
  doc.text('Total expenses', 50, doc.y, { continued: true, width: 350 });
  doc.text(money(totalExpenses), { align: 'right' });
  const net = data.revenue - totalExpenses;
  doc.fillColor(net >= 0 ? '#065f46' : '#991b1b');
  doc.text('Net (revenue - expenses)', 50, doc.y, { continued: true, width: 350 });
  doc.text(money(net), { align: 'right' });
  doc.fillColor('#000');

  doc.moveDown(1.5);

  // Production & stock
  doc.font('Helvetica-Bold').fontSize(13).text('Production & stock');
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10);
  [
    ['Bottles filled this month', data.bottlesFilled],
    ['Bottles delivered this month', data.bottlesDelivered],
    ['Empty bottles purchased this month', data.emptyBottlesPurchased],
    ['Empty bottle stock (as of report date)', data.emptyStockNow],
    ['Filled bottle stock (as of report date)', data.filledStockNow],
    ['Deliveries made', data.deliveryCount],
  ].forEach(([label, val]) => {
    doc.text(label, 50, doc.y, { continued: true, width: 350 });
    doc.text(String(val), { align: 'right' });
  });

  doc.moveDown(1.5);

  // Worker breakdown
  doc.font('Helvetica-Bold').fontSize(13).text('Worker breakdown');
  doc.moveDown(0.3);
  const tableTop = doc.y;
  doc.font('Helvetica-Bold').fontSize(9);
  doc.text('Worker', 50, tableTop);
  doc.text('Days present', 260, tableTop, { width: 90, align: 'right' });
  doc.text('Bottles filled', 350, tableTop, { width: 90, align: 'right' });
  doc.text('Wages paid', 445, tableTop, { width: 100, align: 'right' });
  doc.moveTo(50, tableTop + 14).lineTo(545, tableTop + 14).strokeColor('#ccc').stroke();
  doc.moveDown(1.2);

  doc.font('Helvetica').fontSize(9);
  if (data.workers.length === 0) {
    doc.text('No attendance recorded this month.');
  }
  data.workers.forEach(w => {
    const y = doc.y;
    doc.text(w.name, 50, y);
    doc.text(String(w.daysPresent), 260, y, { width: 90, align: 'right' });
    doc.text(String(w.bottlesFilled), 350, y, { width: 90, align: 'right' });
    doc.text(money(w.wagesPaid), 445, y, { width: 100, align: 'right' });
    doc.moveDown(0.6);
  });

  // Bottles filled by type/quality
  if (data.byVariant && data.byVariant.length > 0) {
    doc.moveDown(1.5);
    doc.font('Helvetica-Bold').fontSize(13).text('Bottles filled by type & quality');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    data.byVariant.forEach(v => {
      doc.text(`${v.type_name} / ${v.quality_name}`, 50, doc.y, { continued: true, width: 350 });
      doc.text(String(v.filled), { align: 'right' });
    });
  }

  // Top clients
  if (data.topClients && data.topClients.length > 0) {
    doc.moveDown(1);
    doc.font('Helvetica-Bold').fontSize(13).text('Top clients this month');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);
    data.topClients.forEach(c => {
      doc.text(`${c.client_name}`, 50, doc.y, { continued: true, width: 350 });
      doc.text(`${c.bottles} bottles — ${money(c.total)}`, { align: 'right' });
    });
  }

  doc.moveDown(2);
  doc.fontSize(8).fillColor('#888').text(`Generated on ${new Date().toISOString().slice(0, 10)}`, { align: 'center' });

  doc.end();
}

module.exports = { generateMonthlyReportPDF };
