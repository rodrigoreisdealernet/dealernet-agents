/**
 * Fleet Availability – shared conflict-detection helpers
 *
 * The canonical window-overlap algorithm used by:
 *   - /inventory/calendar (display surface)
 *   - reservation / maintenance write-path validation
 *
 * Keeping it here ensures both surfaces always apply the same rules and
 * prevents a divergence between what the calendar shows and what the
 * database enforces.
 *
 * Overlap convention (inclusive both ends, consistent with the Supabase RPC):
 *   [windowStart, windowEnd] overlaps [requestStart, requestEnd] when:
 *     windowStart <= requestEnd
 *     AND (windowEnd IS NULL OR windowEnd >= requestStart)
 *
 * A null windowEnd means the window is still open (no return yet).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The set of reasons an asset can be blocked for a requested date window.
 * Mirrors the conflict_reason values returned by fleet_get_availability_calendar.
 */
export type ConflictReason =
  | 'on_rent'
  | 'inspection_hold'
  | 'maintenance'
  | 'transfer'
  | 'retired'
  | 'lost'
  | 'conflicting_assignment';

/**
 * A date window – both dates are YYYY-MM-DD strings.
 * A null end means the window is still open (asset not yet returned).
 */
export interface BookingWindow {
  start: string;
  end: string | null;
}

/**
 * A row returned by the fleet_get_availability_calendar RPC.
 */
export interface AvailabilityCalendarRow {
  entity_id: string;
  name: string;
  identifier: string | null;
  branch_id: string | null;
  branch_name: string | null;
  asset_category_id: string | null;
  asset_category_name: string | null;
  operational_status: string;
  maintenance_due_status: string;
  is_available: boolean;
  conflict_reason: ConflictReason | null;
}

// ---------------------------------------------------------------------------
// Core overlap algorithm
// ---------------------------------------------------------------------------

/**
 * Returns true when [windowStart, windowEnd] overlaps [requestStart, requestEnd].
 *
 * Uses inclusive-end boundary convention on both sides (matching the Supabase RPC).
 * A null windowEnd means the window extends to the present (open rental) and always
 * overlaps any request that starts on or before today.
 */
export function windowsOverlap(
  windowStart: string,
  windowEnd: string | null,
  requestStart: string,
  requestEnd: string
): boolean {
  if (windowStart > requestEnd) return false;
  if (windowEnd !== null && windowEnd < requestStart) return false;
  return true;
}

/**
 * Returns true if any booking window in `windows` overlaps [requestStart, requestEnd].
 *
 * This is the canonical conflict-detection function.  Pass it the set of active
 * booking windows for an asset and the requested date range; it returns whether
 * the asset is already committed for that period.
 *
 * Both the calendar surface and the write-path reservation guard should call
 * this function so they remain in sync.
 */
export function detectWindowConflict(
  windows: BookingWindow[],
  requestStart: string,
  requestEnd: string
): boolean {
  return windows.some((w) => windowsOverlap(w.start, w.end, requestStart, requestEnd));
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

/**
 * Operational statuses that block an asset from being rented regardless of
 * whether a date-range overlap exists.
 *
 * Includes both the canonical long forms written by the seed/DB layer
 * ('in_maintenance', 'on_inspection_hold', 'on_transfer') and the shorter
 * forms written by the field-operations app ('maintenance', 'inspection_hold',
 * 'in_transit') so that assets in either vocabulary are correctly blocked.
 *
 * Note: 'on_rent' is intentionally absent.  An asset marked on_rent is only
 * unavailable when an active contract line overlaps the requested window.
 * For future windows where no line conflicts, the asset is available.
 */
export const BLOCKING_OPERATIONAL_STATUSES: ReadonlySet<string> = new Set([
  'in_maintenance',    'maintenance',
  'on_inspection_hold','inspection_hold',
  'on_transfer',       'in_transit',
  'retired',
  'lost',
  'conflicting_assignment',
]);

/**
 * Returns the conflict reason for an asset's current operational status,
 * or null if the status does not block checkout.
 *
 * Accepts both the long forms written by the seed/DB layer
 * ('in_maintenance', 'on_inspection_hold', 'on_transfer') and the shorter
 * forms emitted by the field-operations app ('maintenance', 'inspection_hold',
 * 'in_transit'), mapping both to the same exported ConflictReason value.
 *
 * Note: 'on_rent' is not handled here — rental occupancy is determined by
 * date-window overlap in detectWindowConflict, not by operational_status.
 */
export function operationalStatusConflict(
  operationalStatus: string
): ConflictReason | null {
  switch (operationalStatus) {
    case 'in_maintenance':
    case 'maintenance':
      return 'maintenance';
    case 'on_inspection_hold':
    case 'inspection_hold':
      return 'inspection_hold';
    case 'on_transfer':
    case 'in_transit':
      return 'transfer';
    case 'retired':
      return 'retired';
    case 'lost':
      return 'lost';
    case 'conflicting_assignment':
      return 'conflicting_assignment';
    default:
      return null;
  }
}

/**
 * Determines whether an asset is available for the requested window,
 * given its current operational status and its active booking windows.
 *
 * This mirrors the logic inside fleet_get_availability_calendar so that
 * write-path validation and the calendar surface remain in sync when run
 * purely on the frontend (e.g., for optimistic conflict highlighting).
 */
export function resolveAssetAvailability(
  operationalStatus: string,
  bookingWindows: BookingWindow[],
  requestStart: string,
  requestEnd: string
): { isAvailable: boolean; conflictReason: ConflictReason | null } {
  const statusConflict = operationalStatusConflict(operationalStatus);
  if (statusConflict !== null) {
    return { isAvailable: false, conflictReason: statusConflict };
  }
  if (detectWindowConflict(bookingWindows, requestStart, requestEnd)) {
    return { isAvailable: false, conflictReason: 'on_rent' };
  }
  return { isAvailable: true, conflictReason: null };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Human-readable label for a conflict reason shown in the calendar UI.
 */
export const CONFLICT_REASON_LABELS: Record<ConflictReason, string> = {
  on_rent: 'On Rent',
  inspection_hold: 'Inspection Hold',
  maintenance: 'In Maintenance',
  transfer: 'On Transfer',
  retired: 'Retired',
  lost: 'Lost',
  conflicting_assignment: 'Conflicting Assignment',
};

/**
 * Badge color variant for a conflict reason (maps to the Badge component's
 * variant prop).
 */
export function conflictReasonVariant(
  reason: ConflictReason
): 'destructive' | 'secondary' | 'outline' {
  switch (reason) {
    case 'on_rent':
      return 'destructive';
    case 'inspection_hold':
    case 'maintenance':
      return 'secondary';
    default:
      return 'outline';
  }
}
