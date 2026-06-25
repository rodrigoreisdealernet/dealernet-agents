import { describe, expect, it } from 'vitest';
import {
  windowsOverlap,
  detectWindowConflict,
  operationalStatusConflict,
  resolveAssetAvailability,
  BLOCKING_OPERATIONAL_STATUSES,
} from '@/lib/fleetAvailability';
import type { BookingWindow } from '@/lib/fleetAvailability';

// ---------------------------------------------------------------------------
// windowsOverlap – canonical overlap algorithm
// ---------------------------------------------------------------------------

describe('windowsOverlap', () => {
  it('returns true when window fully contains the request', () => {
    expect(windowsOverlap('2026-06-01', '2026-06-30', '2026-06-10', '2026-06-20')).toBe(true);
  });

  it('returns true when request fully contains the window', () => {
    expect(windowsOverlap('2026-06-10', '2026-06-15', '2026-06-01', '2026-06-30')).toBe(true);
  });

  it('returns true for a partial overlap at the start', () => {
    expect(windowsOverlap('2026-06-01', '2026-06-15', '2026-06-10', '2026-06-30')).toBe(true);
  });

  it('returns true for a partial overlap at the end', () => {
    expect(windowsOverlap('2026-06-20', '2026-06-30', '2026-06-01', '2026-06-25')).toBe(true);
  });

  it('returns true when window start equals request end (inclusive boundary)', () => {
    expect(windowsOverlap('2026-06-15', '2026-06-20', '2026-06-01', '2026-06-15')).toBe(true);
  });

  it('returns true when window end equals request start (inclusive boundary)', () => {
    expect(windowsOverlap('2026-06-01', '2026-06-10', '2026-06-10', '2026-06-20')).toBe(true);
  });

  it('returns false when window ends before request starts', () => {
    expect(windowsOverlap('2026-06-01', '2026-06-09', '2026-06-10', '2026-06-20')).toBe(false);
  });

  it('returns false when window starts after request ends', () => {
    expect(windowsOverlap('2026-06-21', '2026-06-30', '2026-06-01', '2026-06-20')).toBe(false);
  });

  it('returns true for an open-ended window (null end) that starts within the request', () => {
    expect(windowsOverlap('2026-06-10', null, '2026-06-01', '2026-06-30')).toBe(true);
  });

  it('returns true for an open-ended window (null end) that starts before the request', () => {
    expect(windowsOverlap('2026-06-01', null, '2026-06-10', '2026-06-20')).toBe(true);
  });

  it('returns false for an open-ended window that starts after the request ends', () => {
    expect(windowsOverlap('2026-07-01', null, '2026-06-01', '2026-06-30')).toBe(false);
  });

  it('returns true for single-day window equal to single-day request', () => {
    expect(windowsOverlap('2026-06-15', '2026-06-15', '2026-06-15', '2026-06-15')).toBe(true);
  });

  it('returns false for adjacent windows (day-before end)', () => {
    // window ends 2026-06-09, request starts 2026-06-10 → no overlap
    expect(windowsOverlap('2026-06-01', '2026-06-09', '2026-06-10', '2026-06-20')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// detectWindowConflict – checks a set of booking windows
// ---------------------------------------------------------------------------

describe('detectWindowConflict', () => {
  const windows: BookingWindow[] = [
    { start: '2026-06-01', end: '2026-06-07' },
    { start: '2026-06-20', end: '2026-06-25' },
  ];

  it('returns true when the request overlaps the first window', () => {
    expect(detectWindowConflict(windows, '2026-06-05', '2026-06-10')).toBe(true);
  });

  it('returns true when the request overlaps the second window', () => {
    expect(detectWindowConflict(windows, '2026-06-22', '2026-06-28')).toBe(true);
  });

  it('returns false when the request falls entirely between both windows', () => {
    expect(detectWindowConflict(windows, '2026-06-08', '2026-06-19')).toBe(false);
  });

  it('returns false when the request is entirely before all windows', () => {
    expect(detectWindowConflict(windows, '2026-05-01', '2026-05-31')).toBe(false);
  });

  it('returns false when the request is entirely after all windows', () => {
    expect(detectWindowConflict(windows, '2026-07-01', '2026-07-31')).toBe(false);
  });

  it('returns false for an empty windows array (asset has no bookings)', () => {
    expect(detectWindowConflict([], '2026-06-01', '2026-06-30')).toBe(false);
  });

  it('returns true when there is an open-ended window that spans the request', () => {
    const openWindows: BookingWindow[] = [{ start: '2026-06-10', end: null }];
    expect(detectWindowConflict(openWindows, '2026-06-15', '2026-06-20')).toBe(true);
  });

  it('returns false when a previously-cleared window no longer overlaps', () => {
    // Simulate a returned window (now has an end) that no longer conflicts
    const clearedWindows: BookingWindow[] = [{ start: '2026-06-01', end: '2026-06-09' }];
    expect(detectWindowConflict(clearedWindows, '2026-06-10', '2026-06-20')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// operationalStatusConflict – blocking-status mapping
// ---------------------------------------------------------------------------

describe('operationalStatusConflict', () => {
  it('returns maintenance for in_maintenance status', () => {
    expect(operationalStatusConflict('in_maintenance')).toBe('maintenance');
  });

  // Short-form vocabulary written by the field-operations app
  it('returns maintenance for maintenance status (short form)', () => {
    expect(operationalStatusConflict('maintenance')).toBe('maintenance');
  });

  it('returns inspection_hold for on_inspection_hold status', () => {
    expect(operationalStatusConflict('on_inspection_hold')).toBe('inspection_hold');
  });

  // Short-form vocabulary written by the field-operations app
  it('returns inspection_hold for inspection_hold status (short form)', () => {
    expect(operationalStatusConflict('inspection_hold')).toBe('inspection_hold');
  });

  it('returns transfer for on_transfer status', () => {
    expect(operationalStatusConflict('on_transfer')).toBe('transfer');
  });

  // Short-form vocabulary written by the field-operations app
  it('returns transfer for in_transit status (short form)', () => {
    expect(operationalStatusConflict('in_transit')).toBe('transfer');
  });

  it('returns retired for retired status', () => {
    expect(operationalStatusConflict('retired')).toBe('retired');
  });

  it('returns lost for lost status', () => {
    expect(operationalStatusConflict('lost')).toBe('lost');
  });

  it('returns conflicting_assignment for conflicting_assignment status', () => {
    expect(operationalStatusConflict('conflicting_assignment')).toBe('conflicting_assignment');
  });

  it('returns null for available status', () => {
    expect(operationalStatusConflict('available')).toBeNull();
  });

  // on_rent is intentionally not a hard blocker — occupancy is date-window only
  it('returns null for on_rent status (date-window conflict, not permanent block)', () => {
    expect(operationalStatusConflict('on_rent')).toBeNull();
  });

  it('returns null for unknown status', () => {
    expect(operationalStatusConflict('unknown_status')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// BLOCKING_OPERATIONAL_STATUSES set membership
// ---------------------------------------------------------------------------

describe('BLOCKING_OPERATIONAL_STATUSES', () => {
  it('includes in_maintenance', () => {
    expect(BLOCKING_OPERATIONAL_STATUSES.has('in_maintenance')).toBe(true);
  });

  it('includes maintenance (short form)', () => {
    expect(BLOCKING_OPERATIONAL_STATUSES.has('maintenance')).toBe(true);
  });

  it('includes on_inspection_hold', () => {
    expect(BLOCKING_OPERATIONAL_STATUSES.has('on_inspection_hold')).toBe(true);
  });

  it('includes inspection_hold (short form)', () => {
    expect(BLOCKING_OPERATIONAL_STATUSES.has('inspection_hold')).toBe(true);
  });

  it('includes on_transfer', () => {
    expect(BLOCKING_OPERATIONAL_STATUSES.has('on_transfer')).toBe(true);
  });

  it('includes in_transit (short form)', () => {
    expect(BLOCKING_OPERATIONAL_STATUSES.has('in_transit')).toBe(true);
  });

  // on_rent must NOT be in the set — its occupancy check is date-window based
  it('does not include on_rent (checked via date-window overlap, not status)', () => {
    expect(BLOCKING_OPERATIONAL_STATUSES.has('on_rent')).toBe(false);
  });

  it('does not include available', () => {
    expect(BLOCKING_OPERATIONAL_STATUSES.has('available')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveAssetAvailability – combined status + window check
// ---------------------------------------------------------------------------

describe('resolveAssetAvailability', () => {
  const noWindows: BookingWindow[] = [];
  const rentedWindow: BookingWindow[] = [{ start: '2026-06-10', end: '2026-06-20' }];

  it('returns available when status is available and no windows conflict', () => {
    const result = resolveAssetAvailability('available', noWindows, '2026-06-01', '2026-06-09');
    expect(result.isAvailable).toBe(true);
    expect(result.conflictReason).toBeNull();
  });

  it('returns on_rent conflict when a contract window overlaps', () => {
    const result = resolveAssetAvailability('available', rentedWindow, '2026-06-15', '2026-06-25');
    expect(result.isAvailable).toBe(false);
    expect(result.conflictReason).toBe('on_rent');
  });

  it('returns maintenance conflict when operational_status is in_maintenance regardless of date window', () => {
    const result = resolveAssetAvailability('in_maintenance', noWindows, '2026-06-01', '2026-06-30');
    expect(result.isAvailable).toBe(false);
    expect(result.conflictReason).toBe('maintenance');
  });

  it('returns inspection_hold conflict when operational_status is on_inspection_hold', () => {
    const result = resolveAssetAvailability('on_inspection_hold', noWindows, '2026-06-01', '2026-06-30');
    expect(result.isAvailable).toBe(false);
    expect(result.conflictReason).toBe('inspection_hold');
  });

  it('operational_status blocking takes priority over rental window conflict', () => {
    // Asset is in maintenance AND rented — maintenance reason wins
    const result = resolveAssetAvailability('in_maintenance', rentedWindow, '2026-06-15', '2026-06-25');
    expect(result.isAvailable).toBe(false);
    expect(result.conflictReason).toBe('maintenance');
  });

  it('returns available after the blocking inspection state is cleared', () => {
    // Simulate the asset being cleared from inspection: status reverts to available
    const result = resolveAssetAvailability('available', noWindows, '2026-07-01', '2026-07-10');
    expect(result.isAvailable).toBe(true);
    expect(result.conflictReason).toBeNull();
  });

  it('returns available when window ends before request starts (cleared return)', () => {
    const cleared: BookingWindow[] = [{ start: '2026-06-01', end: '2026-06-09' }];
    const result = resolveAssetAvailability('available', cleared, '2026-06-10', '2026-06-20');
    expect(result.isAvailable).toBe(true);
    expect(result.conflictReason).toBeNull();
  });

  // ── Short-form vocabulary regressions ──────────────────────────────────────

  it('blocks with maintenance conflict for short-form "maintenance" status', () => {
    const result = resolveAssetAvailability('maintenance', noWindows, '2026-06-01', '2026-06-30');
    expect(result.isAvailable).toBe(false);
    expect(result.conflictReason).toBe('maintenance');
  });

  it('blocks with inspection_hold conflict for short-form "inspection_hold" status', () => {
    const result = resolveAssetAvailability('inspection_hold', noWindows, '2026-06-01', '2026-06-30');
    expect(result.isAvailable).toBe(false);
    expect(result.conflictReason).toBe('inspection_hold');
  });

  it('blocks with transfer conflict for short-form "in_transit" status', () => {
    const result = resolveAssetAvailability('in_transit', noWindows, '2026-06-01', '2026-06-30');
    expect(result.isAvailable).toBe(false);
    expect(result.conflictReason).toBe('transfer');
  });

  // ── on_rent date-window behaviour regressions ──────────────────────────────

  it('returns available for an on_rent asset with no overlapping contract window (future request)', () => {
    // Asset is currently on_rent but the contract ends before the requested window.
    const pastWindow: BookingWindow[] = [{ start: '2026-06-01', end: '2026-06-09' }];
    const result = resolveAssetAvailability('on_rent', pastWindow, '2026-06-10', '2026-06-20');
    expect(result.isAvailable).toBe(true);
    expect(result.conflictReason).toBeNull();
  });

  it('returns on_rent conflict for an on_rent asset whose contract window overlaps the request', () => {
    const activeWindow: BookingWindow[] = [{ start: '2026-06-10', end: '2026-06-20' }];
    const result = resolveAssetAvailability('on_rent', activeWindow, '2026-06-15', '2026-06-25');
    expect(result.isAvailable).toBe(false);
    expect(result.conflictReason).toBe('on_rent');
  });

  it('returns available for an on_rent asset with an open-ended window that ends before the request', () => {
    // Simulates a current on_rent that was returned (now has an end before our window).
    const returnedWindow: BookingWindow[] = [{ start: '2026-05-01', end: '2026-06-05' }];
    const result = resolveAssetAvailability('on_rent', returnedWindow, '2026-06-10', '2026-06-20');
    expect(result.isAvailable).toBe(true);
    expect(result.conflictReason).toBeNull();
  });

  it('returns on_rent conflict for an on_rent asset with an open-ended (null end) active window', () => {
    const openWindow: BookingWindow[] = [{ start: '2026-06-01', end: null }];
    const result = resolveAssetAvailability('on_rent', openWindow, '2026-06-10', '2026-06-20');
    expect(result.isAvailable).toBe(false);
    expect(result.conflictReason).toBe('on_rent');
  });
});
