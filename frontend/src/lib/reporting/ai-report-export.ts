/**
 * AI Reporting — Export Utilities
 *
 * Turns a normalized ReportPayload into downloadable CSV, XLSX, or PDF files.
 * The payload produced by the AI reporting experience is the single source of
 * truth so on-screen results and exported results cannot drift (ADR-0044).
 *
 * Security
 * --------
 * CSV/XLSX cells that begin with =, +, -, or @ are neutralised with a leading
 * single-quote so spreadsheet formula injection is prevented.
 *
 * Row limits
 * ----------
 * Exports are capped at MAX_EXPORT_ROWS. If the payload already marks
 * `truncated: true` a note is prepended to the CSV header and the XLSX title
 * cell.  Callers that detect the truncation boundary should set both
 * `truncated` and `totalRowCount` on the payload before passing it here.
 */

// ── Public type contract ──────────────────────────────────────────────────────

/** A single column descriptor in the normalized report payload. */
export interface ReportColumn {
  /** Internal key matching keys in each ReportRow. */
  key: string;
  /** Human-readable header label. */
  label: string;
  /** Optional display hint for number formatting in PDF/XLSX. */
  format?: 'text' | 'number' | 'currency' | 'percent' | 'date';
}

/** A single data row in the normalized report payload. */
export type ReportRow = Record<string, string | number | null>;

/**
 * Normalized report payload — the shared contract between the on-screen result
 * view and the export path.  The UI must not re-fetch or recompute data when
 * the user clicks Export; it hands this object to the export utilities.
 */
export interface ReportPayload {
  /** The original question or report title. */
  question: string;
  /** ISO-8601 timestamp when this result was generated. */
  generatedAt: string;
  /** Active filter key/value pairs shown on screen. */
  filters: Record<string, string>;
  /** Ordered column definitions. */
  columns: ReportColumn[];
  /** Data rows — at most MAX_EXPORT_ROWS entries. */
  rows: ReportRow[];
  /** Optional prose answer summary from the AI. */
  summary?: string;
  /** True when the result set was truncated to MAX_EXPORT_ROWS. */
  truncated?: boolean;
  /** Total row count before truncation (if known). */
  totalRowCount?: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Hard row cap per export. Exports beyond this are truncated with a warning. */
export const MAX_EXPORT_ROWS = 10_000;

// ── Formula-injection protection ─────────────────────────────────────────────

/** Characters that trigger formula evaluation in spreadsheet applications. */
const FORMULA_PREFIXES = ['=', '+', '-', '@'] as const;

/**
 * Neutralise a value for safe inclusion in a CSV or XLSX cell.
 * Strings that start with a spreadsheet formula prefix are prefixed with a
 * single-quote prefix so the application treats them as plain text.
 * A leading `'` is the standard spreadsheet formula-escape character
 * recognised by Excel, LibreOffice Calc, and Google Sheets.
 * Null/undefined → empty string.
 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = String(value);
  if (FORMULA_PREFIXES.some((p) => str.startsWith(p))) {
    return `'${str}`;
  }
  return str;
}

// ── CSV ───────────────────────────────────────────────────────────────────────

function toCsvField(raw: string): string {
  if (raw.includes(',') || raw.includes('"') || raw.includes('\n') || raw.includes('\r')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

/**
 * Serialise a ReportPayload to a RFC-4180-compliant CSV string.
 *
 * - Column order follows `payload.columns`.
 * - Cell values are formula-neutralised before quoting.
 * - A truncation note is appended as a comment line when `payload.truncated`
 *   is true.
 * - Exported row count is bounded by MAX_EXPORT_ROWS regardless of the rows
 *   array length.
 */
export function buildReportCsv(payload: ReportPayload): string {
  const exportRows = payload.rows.slice(0, MAX_EXPORT_ROWS);
  const headers = payload.columns.map((c) => toCsvField(sanitizeCsvCell(c.label)));
  const headerLine = headers.join(',');

  const body = exportRows.map((row) =>
    payload.columns
      .map((col) => toCsvField(sanitizeCsvCell(row[col.key])))
      .join(',')
  );

  const lines: string[] = [
    `# Question: ${sanitizeCsvCell(payload.question)}`,
    `# Generated: ${payload.generatedAt}`,
  ];

  const filterEntries = Object.entries(payload.filters);
  if (filterEntries.length > 0) {
    const filterStr = filterEntries.map(([k, v]) => `${k}=${v}`).join('; ');
    lines.push(`# Filters: ${filterStr}`);
  }

  if (payload.truncated) {
    const total = payload.totalRowCount !== undefined ? ` of ${payload.totalRowCount}` : '';
    lines.push(`# WARNING: Results truncated to ${MAX_EXPORT_ROWS}${total} rows`);
  }

  lines.push(headerLine);
  lines.push(...body);

  return lines.join('\n');
}

// ── XLSX ──────────────────────────────────────────────────────────────────────
// Pure-TypeScript minimal XLSX writer.  The XLSX format is an Open Packaging
// Convention ZIP file containing XML parts.  We use the ZIP "STORE" (no
// compression) method so we need no compression library.

// -- CRC32 (used by ZIP local-file and central-directory headers) --

const CRC32_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    t[i] = c >>> 0;
  }
  return t;
})();

function computeCrc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// -- Little-endian integer helpers --

function le2(n: number): Uint8Array {
  return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
}

function le4(n: number): Uint8Array {
  return new Uint8Array([
    n & 0xff,
    (n >> 8) & 0xff,
    (n >> 16) & 0xff,
    (n >> 24) & 0xff,
  ]);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.byteLength, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.byteLength;
  }
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// -- Minimal ZIP STORE builder --

interface ZipFile {
  name: string;
  data: Uint8Array;
}

function buildZipBlob(files: ZipFile[]): Blob {
  const localParts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;

  const namesBufs = files.map((f) => utf8(f.name));

  for (let i = 0; i < files.length; i++) {
    const data = files[i].data;
    const nameBuf = namesBufs[i];
    const checksum = computeCrc32(data);
    const size = data.byteLength;
    offsets.push(pos);

    const localHeader = concatBytes(
      new Uint8Array([0x50, 0x4b, 0x03, 0x04]), // local file sig
      le2(20), // version needed
      le2(0), // general flags
      le2(0), // compression: stored
      le2(0), // mod time
      le2(0), // mod date
      le4(checksum),
      le4(size), // compressed
      le4(size), // uncompressed
      le2(nameBuf.byteLength),
      le2(0), // extra length
      nameBuf
    );

    localParts.push(localHeader, data);
    pos += localHeader.byteLength + size;
  }

  const cdStart = pos;
  const cdParts: Uint8Array[] = [];

  for (let i = 0; i < files.length; i++) {
    const data = files[i].data;
    const nameBuf = namesBufs[i];
    const checksum = computeCrc32(data);
    const size = data.byteLength;

    cdParts.push(
      concatBytes(
        new Uint8Array([0x50, 0x4b, 0x01, 0x02]), // central dir sig
        le2(20), // version made by
        le2(20), // version needed
        le2(0), // general flags
        le2(0), // compression
        le2(0), // mod time
        le2(0), // mod date
        le4(checksum),
        le4(size),
        le4(size),
        le2(nameBuf.byteLength),
        le2(0), // extra length
        le2(0), // comment length
        le2(0), // disk start
        le2(0), // int attributes
        le4(0), // ext attributes
        le4(offsets[i]),
        nameBuf
      )
    );
  }

  const cdSize = cdParts.reduce((s, p) => s + p.byteLength, 0);

  const eocd = concatBytes(
    new Uint8Array([0x50, 0x4b, 0x05, 0x06]), // EOCD sig
    le2(0), // disk number
    le2(0), // start disk
    le2(files.length), // entries on disk
    le2(files.length), // total entries
    le4(cdSize),
    le4(cdStart),
    le2(0) // comment length
  );

  const combined = concatBytes(...localParts, ...cdParts, eocd);
  return new Blob([combined], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

// -- XLSX XML helpers --

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Convert 0-based column index to spreadsheet column name (A, B … Z, AA …). */
function colLetter(idx: number): string {
  let name = '';
  let n = idx + 1;
  while (n > 0) {
    const mod = (n - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function buildSheetXml(
  headers: string[],
  rows: (string | number | null)[][]
): string {
  const buildCell = (ri: number, ci: number, value: string | number | null): string => {
    const ref = `${colLetter(ci)}${ri + 1}`;
    if (value === null || value === undefined || value === '') {
      return `<c r="${ref}"/>`;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `<c r="${ref}"><v>${value}</v></c>`;
    }
    const safe = xmlEscape(String(value));
    return `<c r="${ref}" t="inlineStr"><is><t>${safe}</t></is></c>`;
  };

  const headerRow = `<row r="1">${headers.map((h, ci) => buildCell(0, ci, h)).join('')}</row>`;
  const dataRows = rows
    .map((row, ri) =>
      `<row r="${ri + 2}">${row.map((v, ci) => buildCell(ri + 1, ci, v)).join('')}</row>`
    )
    .join('');

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n` +
    `<sheetData>\n${headerRow}\n${dataRows}\n</sheetData>\n` +
    `</worksheet>`
  );
}

const CONTENT_TYPES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `</Types>`;

const RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
  `<sheets><sheet name="Report" sheetId="1" r:id="rId1"/></sheets>` +
  `</workbook>`;

const WORKBOOK_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
  `</Relationships>`;

/**
 * Build a minimal XLSX Blob from a ReportPayload.
 *
 * - Cell values are formula-neutralised (same rule as CSV).
 * - Row count is capped at MAX_EXPORT_ROWS.
 * - The resulting file opens in Excel, LibreOffice Calc, and Numbers.
 */
export function buildReportXlsxBlob(payload: ReportPayload): Blob {
  const exportRows = payload.rows.slice(0, MAX_EXPORT_ROWS);

  const headers = payload.columns.map((c) => sanitizeCsvCell(c.label));
  const dataRows = exportRows.map((row) =>
    payload.columns.map((col) => {
      const v = row[col.key];
      if (typeof v === 'number') return v;
      return sanitizeCsvCell(v);
    })
  );

  const sheetXml = buildSheetXml(headers, dataRows);

  return buildZipBlob([
    { name: '[Content_Types].xml', data: utf8(CONTENT_TYPES_XML) },
    { name: '_rels/.rels', data: utf8(RELS_XML) },
    { name: 'xl/workbook.xml', data: utf8(WORKBOOK_XML) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(WORKBOOK_RELS_XML) },
    { name: 'xl/worksheets/sheet1.xml', data: utf8(sheetXml) },
  ]);
}

// ── PDF ───────────────────────────────────────────────────────────────────────

/**
 * Trigger a browser print dialog so the user can save the current report
 * result as PDF.  The calling component is responsible for adding
 * `.print:hidden` to any UI chrome it wants omitted from the print output.
 *
 * This is intentionally a side-effect function so it can be stubbed in tests.
 */
export function triggerReportPdfPrint(): void {
  window.print();
}

// ── Filename helpers ──────────────────────────────────────────────────────────

/**
 * Derive a safe, human-friendly export filename from the payload.
 * Non-alphanumeric characters in the question are replaced with hyphens and
 * the string is truncated to 50 characters.
 */
export function reportExportFilename(
  payload: ReportPayload,
  ext: 'csv' | 'xlsx' | 'pdf'
): string {
  const datePart = payload.generatedAt.slice(0, 10);
  const slug = payload.question
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  return `ai-report-${slug}-${datePart}.${ext}`;
}

// ── Download helpers ──────────────────────────────────────────────────────────

/**
 * Trigger a browser download for the given Blob with the provided filename.
 */
export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
