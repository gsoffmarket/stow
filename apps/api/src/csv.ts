// CSV in both directions: reading imports and writing exports. Both follow
// RFC 4180, and writing also defuses spreadsheet formulas, because the cells
// hold names and references that users typed.

/** readCsv splits CSV text into records of fields; quoted fields may hold commas, quotes ("") and line breaks. */
export function readCsv(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      record.push(field);
      records.push(record);
      record = [];
      field = "";
    } else field += char;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** writeCsv renders records as CSV with CRLF line endings. */
export function writeCsv(records: readonly (readonly (string | number)[])[]): string {
  return records.map((record) => record.map(cell).join(",")).join("\r\n") + "\r\n";
}

// RFC 4180 quoting, plus a leading apostrophe on anything a spreadsheet would
// run as a formula (OWASP CSV injection): names and refs come from users.
function cell(value: string | number): string {
  if (typeof value === "number") return String(value);
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
