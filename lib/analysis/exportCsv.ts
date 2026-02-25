export type CsvCell = string | number | boolean | null | undefined;

function escapeCsvValue(value: CsvCell) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, "\"\"")}"`;
  }
  return text;
}

export function toCsv(rows: CsvCell[][]) {
  return rows.map((row) => row.map(escapeCsvValue).join(",")).join("\n");
}

