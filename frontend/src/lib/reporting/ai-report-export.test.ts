/**
 * Unit tests for AI Reporting Export Utilities
 *
 * Covers:
 * - CSV serializer correctness and metadata headers
 * - Formula-neutralisation (injection protection)
 * - XLSX Blob generation (ZIP + XML structure)
 * - Export filename conventions
 * - Row-limit / truncation behaviour
 */

import { describe, expect, it } from 'vitest';
import {
  sanitizeCsvCell,
  buildReportCsv,
  buildReportXlsxBlob,
  reportExportFilename,
  MAX_EXPORT_ROWS,
  type ReportPayload,
} from './ai-report-export';

// ── Shared fixtures ───────────────────────────────────────────────────────────

const PAYLOAD_SIMPLE: ReportPayload = {
  question: 'What is the fleet utilisation for Q2?',
  generatedAt: '2026-06-17T12:00:00.000Z',
  filters: { period: 'Q2 2026', branch: 'Austin' },
  columns: [
    { key: 'branch', label: 'Branch', format: 'text' },
    { key: 'utilisation', label: 'Utilisation %', format: 'percent' },
    { key: 'revenue', label: 'Revenue (USD)', format: 'currency' },
  ],
  rows: [
    { branch: 'Austin', utilisation: 72.5, revenue: 48200 },
    { branch: 'Dallas', utilisation: 58.3, revenue: 31000 },
  ],
  summary: 'Q2 fleet utilisation averages 65.4% across 2 branches.',
};

// ── sanitizeCsvCell ───────────────────────────────────────────────────────────

describe('sanitizeCsvCell', () => {
  it('returns empty string for null', () => {
    expect(sanitizeCsvCell(null)).toBe('');
  });

  it('returns empty string for undefined', () => {
    expect(sanitizeCsvCell(undefined)).toBe('');
  });

  it('passes through plain strings unchanged', () => {
    expect(sanitizeCsvCell('Hello World')).toBe('Hello World');
  });

  it('converts numbers to strings', () => {
    expect(sanitizeCsvCell(42)).toBe('42');
    expect(sanitizeCsvCell(3.14)).toBe('3.14');
  });

  it('neutralises = formula prefix', () => {
    const result = sanitizeCsvCell('=SUM(A1:A10)');
    expect(result).toBe("'=SUM(A1:A10)");
    expect(result).not.toMatch(/^=/);
  });

  it('neutralises + prefix', () => {
    expect(sanitizeCsvCell('+1234')).toBe("'+1234");
  });

  it('neutralises - prefix', () => {
    expect(sanitizeCsvCell('-DROP TABLE users')).toBe("'-DROP TABLE users");
  });

  it('neutralises @ prefix', () => {
    expect(sanitizeCsvCell('@SUM(A:A)')).toBe("'@SUM(A:A)");
  });

  it('does not neutralise strings that do not start with a formula prefix', () => {
    expect(sanitizeCsvCell('Normal text')).toBe('Normal text');
    expect(sanitizeCsvCell('100')).toBe('100');
    expect(sanitizeCsvCell('  spaces')).toBe('  spaces');
  });
});

// ── buildReportCsv ────────────────────────────────────────────────────────────

describe('buildReportCsv', () => {
  it('includes question and generated-at comment lines', () => {
    const csv = buildReportCsv(PAYLOAD_SIMPLE);
    expect(csv).toContain('# Question: What is the fleet utilisation for Q2?');
    expect(csv).toContain('# Generated: 2026-06-17T12:00:00.000Z');
  });

  it('includes active filter metadata', () => {
    const csv = buildReportCsv(PAYLOAD_SIMPLE);
    expect(csv).toContain('# Filters:');
    expect(csv).toContain('period=Q2 2026');
    expect(csv).toContain('branch=Austin');
  });

  it('renders column headers as the first data row', () => {
    const csv = buildReportCsv(PAYLOAD_SIMPLE);
    expect(csv).toContain('Branch,Utilisation %,Revenue (USD)');
  });

  it('renders data rows in column order', () => {
    const csv = buildReportCsv(PAYLOAD_SIMPLE);
    expect(csv).toContain('Austin,72.5,48200');
    expect(csv).toContain('Dallas,58.3,31000');
  });

  it('wraps fields with commas in double quotes', () => {
    const payload: ReportPayload = {
      ...PAYLOAD_SIMPLE,
      rows: [{ branch: 'Austin, TX', utilisation: 70, revenue: 40000 }],
    };
    const csv = buildReportCsv(payload);
    expect(csv).toContain('"Austin, TX"');
  });

  it('escapes double quotes inside fields per RFC 4180', () => {
    const payload: ReportPayload = {
      ...PAYLOAD_SIMPLE,
      rows: [{ branch: 'Branch "A"', utilisation: 60, revenue: 20000 }],
    };
    const csv = buildReportCsv(payload);
    expect(csv).toContain('"Branch ""A"""');
  });

  it('neutralises formula-injection values in data rows', () => {
    const payload: ReportPayload = {
      ...PAYLOAD_SIMPLE,
      rows: [{ branch: '=HYPERLINK("evil.example","click")', utilisation: 0, revenue: 0 }],
    };
    const csv = buildReportCsv(payload);
    // The single-quote-prefixed value should be present (injection neutralised)
    expect(csv).toContain("'=HYPERLINK");
    // No CSV field should start directly with = (formula prefix stripped to start of field)
    const lines = csv.split('\n');
    const dataLines = lines.filter((l) => !l.startsWith('#') && !l.startsWith('Branch'));
    for (const line of dataLines) {
      const fields = line.split(',');
      for (const field of fields) {
        // Fields may be quoted; strip quotes for the leading-char check
        const bare = field.startsWith('"') ? field.slice(1) : field;
        expect(bare).not.toMatch(/^=/);
      }
    }
  });

  it('handles null cell values gracefully (empty field)', () => {
    const payload: ReportPayload = {
      ...PAYLOAD_SIMPLE,
      rows: [{ branch: 'Austin', utilisation: null, revenue: null }],
    };
    const csv = buildReportCsv(payload);
    expect(csv).toContain('Austin,,');
  });

  it('omits filter comment line when no filters are active', () => {
    const payload: ReportPayload = { ...PAYLOAD_SIMPLE, filters: {} };
    const csv = buildReportCsv(payload);
    expect(csv).not.toContain('# Filters:');
  });

  it('appends truncation warning when payload is marked truncated', () => {
    const payload: ReportPayload = {
      ...PAYLOAD_SIMPLE,
      truncated: true,
      totalRowCount: 50_000,
    };
    const csv = buildReportCsv(payload);
    expect(csv).toContain('WARNING: Results truncated');
    expect(csv).toContain('50000');
  });

  it('does not append truncation warning when payload is not truncated', () => {
    const csv = buildReportCsv(PAYLOAD_SIMPLE);
    expect(csv).not.toContain('WARNING');
  });

  it('caps exported rows at MAX_EXPORT_ROWS', () => {
    const rows = Array.from({ length: MAX_EXPORT_ROWS + 100 }, (_, i) => ({
      branch: `B${i}`,
      utilisation: i,
      revenue: i * 100,
    }));
    const payload: ReportPayload = { ...PAYLOAD_SIMPLE, rows };
    const csv = buildReportCsv(payload);

    // Count data lines (excluding comment + header lines)
    const lines = csv.split('\n');
    const dataLines = lines.filter((l) => !l.startsWith('#') && l.trim() !== '' && !l.startsWith('Branch'));
    expect(dataLines.length).toBe(MAX_EXPORT_ROWS);
  });

  it('is deterministic — identical input produces identical output', () => {
    expect(buildReportCsv(PAYLOAD_SIMPLE)).toBe(buildReportCsv(PAYLOAD_SIMPLE));
  });
});

// ── buildReportXlsxBlob ───────────────────────────────────────────────────────

describe('buildReportXlsxBlob', () => {
  it('returns a Blob with the correct MIME type', () => {
    const blob = buildReportXlsxBlob(PAYLOAD_SIMPLE);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  });

  it('returns a non-empty Blob', () => {
    const blob = buildReportXlsxBlob(PAYLOAD_SIMPLE);
    expect(blob.size).toBeGreaterThan(0);
  });

  it('starts with the PK ZIP signature bytes', async () => {
    const blob = buildReportXlsxBlob(PAYLOAD_SIMPLE);
    const buf = await blob.arrayBuffer();
    const view = new Uint8Array(buf);
    // ZIP local file header magic: 0x50 0x4B 0x03 0x04
    expect(view[0]).toBe(0x50);
    expect(view[1]).toBe(0x4b);
    expect(view[2]).toBe(0x03);
    expect(view[3]).toBe(0x04);
  });

  it('contains column header labels in the binary output', async () => {
    const blob = buildReportXlsxBlob(PAYLOAD_SIMPLE);
    const text = await blob.text();
    expect(text).toContain('Branch');
    expect(text).toContain('Utilisation %');
    expect(text).toContain('Revenue (USD)');
  });

  it('contains data row values in the binary output', async () => {
    const blob = buildReportXlsxBlob(PAYLOAD_SIMPLE);
    const text = await blob.text();
    expect(text).toContain('Austin');
    expect(text).toContain('Dallas');
  });

  it('neutralises formula-injection values in XLSX cells', async () => {
    const payload: ReportPayload = {
      ...PAYLOAD_SIMPLE,
      rows: [{ branch: '=HYPERLINK("evil.example","click")', utilisation: 0, revenue: 0 }],
    };
    const blob = buildReportXlsxBlob(payload);
    const text = await blob.text();
    // The single-quote prefix is XML-entity-encoded as &apos; inside the sheet XML
    expect(text).toContain("&apos;=HYPERLINK");
    // No <t> element should start directly with an unescaped = (bare formula)
    // The XML-encoded cell text begins with &apos; not =, so this holds.
    expect(text).not.toMatch(/<t>=/);
  });

  it('caps exported rows at MAX_EXPORT_ROWS', async () => {
    const rows = Array.from({ length: MAX_EXPORT_ROWS + 500 }, (_, i) => ({
      branch: `B${i}`,
      utilisation: i,
      revenue: i * 100,
    }));
    const payload: ReportPayload = { ...PAYLOAD_SIMPLE, rows };
    const blob = buildReportXlsxBlob(payload);
    const text = await blob.text();

    // Header occupies row 1. Data rows 2 … MAX_EXPORT_ROWS+1 are all that should exist.
    // Row MAX_EXPORT_ROWS+2 would be the first truncated row — it must not appear.
    expect(text).toContain(`r="${MAX_EXPORT_ROWS + 1}"`);
    expect(text).not.toContain(`r="${MAX_EXPORT_ROWS + 2}"`);
  });

  it('is deterministic — identical input produces identical Blob size', () => {
    expect(buildReportXlsxBlob(PAYLOAD_SIMPLE).size).toBe(
      buildReportXlsxBlob(PAYLOAD_SIMPLE).size
    );
  });
});

// ── reportExportFilename ──────────────────────────────────────────────────────

describe('reportExportFilename', () => {
  it('generates a csv filename', () => {
    const name = reportExportFilename(PAYLOAD_SIMPLE, 'csv');
    expect(name).toMatch(/\.csv$/);
  });

  it('generates an xlsx filename', () => {
    const name = reportExportFilename(PAYLOAD_SIMPLE, 'xlsx');
    expect(name).toMatch(/\.xlsx$/);
  });

  it('generates a pdf filename', () => {
    const name = reportExportFilename(PAYLOAD_SIMPLE, 'pdf');
    expect(name).toMatch(/\.pdf$/);
  });

  it('includes the date from generatedAt', () => {
    const name = reportExportFilename(PAYLOAD_SIMPLE, 'csv');
    expect(name).toContain('2026-06-17');
  });

  it('slugifies the question into the filename', () => {
    const name = reportExportFilename(PAYLOAD_SIMPLE, 'csv');
    expect(name).toContain('fleet-utilisation');
  });

  it('starts with the ai-report prefix', () => {
    const name = reportExportFilename(PAYLOAD_SIMPLE, 'csv');
    expect(name).toMatch(/^ai-report-/);
  });

  it('limits the question slug to 50 characters', () => {
    const payload: ReportPayload = {
      ...PAYLOAD_SIMPLE,
      question: 'A'.repeat(200),
    };
    const name = reportExportFilename(payload, 'csv');
    // slug should be at most 50 chars; filename prefix + date + ext add more
    const slug = name.replace(/^ai-report-/, '').replace(/-\d{4}-\d{2}-\d{2}\.csv$/, '');
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it('removes leading and trailing hyphens from the slug', () => {
    const payload: ReportPayload = {
      ...PAYLOAD_SIMPLE,
      question: '  ?!fleet utilisation?!  ',
    };
    const name = reportExportFilename(payload, 'csv');
    expect(name).not.toMatch(/^ai-report--/);
    expect(name).not.toMatch(/---\d{4}/);
  });
});
