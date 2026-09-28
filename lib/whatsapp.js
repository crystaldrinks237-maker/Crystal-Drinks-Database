/**
 * Turns a phone number as people actually write it ("0311-1234567", "+92 311 1234567",
 * "311 1234567") into the digits-only international form WhatsApp links need
 * ("923111234567"). Returns null when there's nothing usable.
 */
function normalizePhone(phone, countryCode = '92') {
  let d = String(phone || '').replace(/\D/g, '');
  const cc = String(countryCode || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);            // 0092... -> 92...
  else if (d.startsWith('0')) d = cc + d.slice(1);   // 0311... -> 92311...
  else if (cc && !d.startsWith(cc) && d.length <= 10) d = cc + d; // 311... -> 92311...
  return d.length >= 8 ? d : null;
}

/** A wa.me link that opens WhatsApp with the message already typed. Without a phone, WhatsApp lets you pick the contact. */
function waLink(phone, text, countryCode) {
  const n = normalizePhone(phone, countryCode);
  return `https://wa.me/${n || ''}?text=${encodeURIComponent(text)}`;
}

const money = n => {
  const v = Math.round((Number(n) || 0) * 100) / 100;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
};

function reminderText({ company, customerName, balance, date }) {
  return `Hello ${customerName}, this is a friendly reminder from ${company}. ` +
    `Your outstanding balance as of ${date} is ${money(balance)}. ` +
    `Please arrange payment at your earliest convenience. Thank you!`;
}

function invoiceText({ company, customerName, invoiceNumber, date, billed, paid, balance }) {
  let t = `Hello ${customerName}, here are the details of your ${company} delivery on ${date} (invoice ${invoiceNumber}): ` +
    `bill ${money(billed)}`;
  if (paid > 0) t += `, received ${money(paid)}`;
  if (balance > 0) t += `. Balance due: ${money(balance)}.`;
  else if (balance < 0) t += `. You have a credit of ${money(-balance)}.`;
  else t += `. Paid in full.`;
  return t + ' Thank you!';
}

function statementText({ company, customerName, balance, date }) {
  let t = `Hello ${customerName}, here is your account statement from ${company} as of ${date}. `;
  if (balance > 0) t += `Balance due: ${money(balance)}. `;
  else if (balance < 0) t += `You have a credit of ${money(-balance)}. `;
  else t += `Your account is fully settled. `;
  return t + 'Thank you!';
}

module.exports = { normalizePhone, waLink, reminderText, invoiceText, statementText };
