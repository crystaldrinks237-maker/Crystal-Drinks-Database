function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n]/.test(str)) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * rows: array of plain objects
 * columns: array of { key, label }
 */
function toCSV(rows, columns) {
  const header = columns.map(c => csvEscape(c.label)).join(',');
  const lines = rows.map(row =>
    columns.map(c => csvEscape(row[c.key])).join(',')
  );
  return [header, ...lines].join('\n');
}

module.exports = { toCSV };
