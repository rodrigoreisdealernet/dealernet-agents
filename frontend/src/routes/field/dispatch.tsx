/**
 * Driver Mobile Dispatch Execution
 *
 * Driver-facing mobile experience for advanced logistics:
 * - Assignment inbox: today's route stops in sequence order.
 * - Route progression: depart → arrive → complete state machine per stop.
 * - Navigation handoff: deep-link to the device's default maps app.
 * - Field evidence: e-signature, condition notes, and photo capture
 *   stored against each stop (and propagated to linked contract-line records).
 * - Offline resilience: actions are queued locally and replayed automatically
 *   on reconnect.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  LogIn,
  MapPin,
  Navigation,
  Package,
  Shield,
  Truck,
  WifiOff,
} from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/auth/AuthContext';
import { canOperate } from '@/auth/types';
import { supabase } from '@/data/supabase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StopStatus = 'pending' | 'departed' | 'arrived' | 'completed';
type StopType = 'delivery' | 'pickup';
type RouteStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';
type TelemetryPositionStatus = 'fresh' | 'stale' | 'missing' | 'unknown';
type EldComplianceStatus = 'compliant' | 'warning' | 'violation' | 'unknown';
type DriverLogStatus = 'current' | 'missing' | 'out_of_hours' | 'unknown';

export type RouteStop = {
  stopId: string;
  routeId: string;
  routeDate: string;
  routeStatus: RouteStatus;
  sequenceOrder: number;
  stopType: StopType;
  stopStatus: StopStatus;
  contractLineId: string | null;
  assetId: string | null;
  address: string | null;
  addressLat: number | null;
  addressLng: number | null;
  customerName: string | null;
  jobSiteName: string | null;
  contactName: string | null;
  contactPhone: string | null;
  notes: string | null;
  signature: string | null;
  conditionNotes: string | null;
  photoPaths: string[];
  departedAt: string | null;
  arrivedAt: string | null;
  completedAt: string | null;
  telemetryPositionStatus: TelemetryPositionStatus;
  eldComplianceStatus: EldComplianceStatus;
  driverLogStatus: DriverLogStatus;
  telemetryEventAt: string | null;
  dvirSubmitted: boolean;
  exceptionCount: number;
};

type DriverDispatchStopRow = {
  stop_id: string | null;
  route_id: string | null;
  route_date: string | null;
  route_status: RouteStatus | null;
  sequence_order: number | null;
  stop_type: StopType | null;
  stop_status: StopStatus | null;
  contract_line_id: string | null;
  asset_id: string | null;
  address: string | null;
  address_lat: number | null;
  address_lng: number | null;
  customer_name: string | null;
  job_site_name: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
  signature: string | null;
  condition_notes: string | null;
  photo_paths: string[] | null;
  departed_at: string | null;
  arrived_at: string | null;
  completed_at: string | null;
  telemetry_position_status: TelemetryPositionStatus | null;
  eld_compliance_status: EldComplianceStatus | null;
  driver_log_status: DriverLogStatus | null;
  telemetry_event_at: string | null;
  dvir_submitted: boolean | null;
  exception_count: number | null;
};

type ExceptionType = 'eta_delay' | 'access_issue' | 'damage' | 'missing_attachment';

const EXCEPTION_TYPE_LABELS: Record<ExceptionType, string> = {
  eta_delay: 'ETA / Delay',
  access_issue: 'Access Issue',
  damage: 'Damage',
  missing_attachment: 'Missing Attachment',
};

/** A locally-queued action to replay when connectivity is restored. */
type QueuedStopAction = {
  id: string;
  stopId: string;
  targetStatus: StopStatus;
  signature: string;
  conditionNotes: string;
  photoPaths: string[];
  queuedAt: string;
  retries: number;
};

/** A DVIR submission queued offline for replay on reconnect. */
type QueuedDvirAction = {
  id: string;
  routeId: string;
  truckId: string;
  odometerReading: string;
  defects: Array<{ item: string; severity: string }>;
  isSafeToDrive: boolean;
  notes: string;
  signature: string;
  queuedAt: string;
  retries: number;
};

type DvirDefect = { item: string; severity: string };
type DvirDefectSeverity = 'critical' | 'minor' | 'cosmetic';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUEUE_STORAGE_KEY = 'dispatch_action_queue';
const DVIR_QUEUE_STORAGE_KEY = 'dispatch_dvir_queue';
const DVIR_DEFECT_SEVERITY_LABELS: Record<DvirDefectSeverity, string> = {
  critical: 'Critical',
  minor: 'Minor',
  cosmetic: 'Cosmetic',
};
const STOP_STATUS_LABELS: Record<StopStatus, string> = {
  pending: 'Pending',
  departed: 'Departed',
  arrived: 'Arrived',
  completed: 'Completed',
};
const LOCATION_TIMEOUT_MS = 10_000;
const MAX_REPLAY_RETRIES = 5;
const DRIVER_LOG_LABELS: Record<DriverLogStatus, string> = {
  current: 'Current',
  missing: 'Missing',
  out_of_hours: 'Out of hours',
  unknown: 'Unknown',
};
const ELD_STATUS_LABELS: Record<EldComplianceStatus, string> = {
  compliant: 'Compliant',
  warning: 'Warning',
  violation: 'Violation',
  unknown: 'Unknown',
};
const TELEMETRY_POSITION_LABELS: Record<TelemetryPositionStatus, string> = {
  fresh: 'Fresh',
  stale: 'Stale',
  missing: 'Missing',
  unknown: 'Unknown',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sanitizeStoragePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
}

function createUploadKeyPrefix(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function sanitizeUploadFilename(fileName: string): string {
  const withoutPath = fileName.split('/').pop()?.split('\\').pop() || 'photo';
  const dotIndex = withoutPath.lastIndexOf('.');
  const rawBaseName = dotIndex > 0 ? withoutPath.slice(0, dotIndex) : withoutPath;
  const rawExtension = dotIndex > 0 ? withoutPath.slice(dotIndex + 1) : '';
  const baseName = rawBaseName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'photo';
  const extension = rawExtension.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  return extension ? `${baseName}.${extension}` : baseName;
}

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function buildMapsUrl(address: string, lat: number | null, lng: number | null): string {
  if (lat !== null && lng !== null) {
    return `https://maps.google.com/?q=${lat},${lng}`;
  }
  return `https://maps.google.com/?q=${encodeURIComponent(address)}`;
}

/** Returns the next valid state after the current one, or null if already complete. */
export function nextStopStatus(current: StopStatus): StopStatus | null {
  if (current === 'pending') return 'departed';
  if (current === 'departed') return 'arrived';
  if (current === 'arrived') return 'completed';
  return null;
}

// ---------------------------------------------------------------------------
// Offline queue helpers
// ---------------------------------------------------------------------------

function loadQueue(): QueuedStopAction[] {
  try {
    const raw = localStorage.getItem(QUEUE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as QueuedStopAction[]) : [];
  } catch {
    return [];
  }
}

function saveQueue(queue: QueuedStopAction[]): void {
  try {
    localStorage.setItem(QUEUE_STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Storage unavailable — degrade gracefully.
  }
}

function enqueueAction(action: Omit<QueuedStopAction, 'id' | 'queuedAt' | 'retries'>): void {
  const queue = loadQueue();
  queue.push({
    ...action,
    id: createUploadKeyPrefix(),
    queuedAt: new Date().toISOString(),
    retries: 0,
  });
  saveQueue(queue);
}

function removeFromQueue(actionId: string): void {
  const queue = loadQueue().filter((a) => a.id !== actionId);
  saveQueue(queue);
}

function incrementRetry(actionId: string): void {
  const queue = loadQueue().map((a) => (a.id === actionId ? { ...a, retries: a.retries + 1 } : a));
  saveQueue(queue);
}

function applyQueuedStopActions(stops: RouteStop[], queue: QueuedStopAction[]): RouteStop[] {
  if (queue.length === 0) return stops;

  const byStopId = new Map(stops.map((stop) => [stop.stopId, stop]));

  for (const action of queue) {
    const current = byStopId.get(action.stopId);
    if (!current) continue;

    const next: RouteStop = {
      ...current,
      stopStatus: action.targetStatus,
      signature: action.signature !== '' ? action.signature : current.signature,
      conditionNotes: action.conditionNotes !== '' ? action.conditionNotes : current.conditionNotes,
      photoPaths: action.photoPaths.length > 0 ? action.photoPaths : current.photoPaths,
    };

    if (action.targetStatus === 'departed' && !next.departedAt) {
      next.departedAt = action.queuedAt;
    }
    if (action.targetStatus === 'arrived') {
      if (!next.departedAt) next.departedAt = action.queuedAt;
      if (!next.arrivedAt) next.arrivedAt = action.queuedAt;
    }
    if (action.targetStatus === 'completed') {
      if (!next.departedAt) next.departedAt = action.queuedAt;
      if (!next.arrivedAt) next.arrivedAt = action.queuedAt;
      if (!next.completedAt) next.completedAt = action.queuedAt;
    }

    byStopId.set(action.stopId, next);
  }

  return stops.map((stop) => byStopId.get(stop.stopId) ?? stop);
}

// ── DVIR offline queue helpers ───────────────────────────────────────────────

export function loadDvirQueue(): QueuedDvirAction[] {
  try {
    const raw = localStorage.getItem(DVIR_QUEUE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as QueuedDvirAction[]) : [];
  } catch {
    return [];
  }
}

function saveDvirQueue(queue: QueuedDvirAction[]): void {
  try {
    localStorage.setItem(DVIR_QUEUE_STORAGE_KEY, JSON.stringify(queue));
  } catch {
    // Storage unavailable — degrade gracefully.
  }
}

function enqueueDvirAction(action: Omit<QueuedDvirAction, 'id' | 'queuedAt' | 'retries'>): void {
  const queue = loadDvirQueue();
  // One DVIR per route — silently ignore duplicate submissions for the same route.
  if (queue.some((a) => a.routeId === action.routeId)) return;
  queue.push({
    ...action,
    id: createUploadKeyPrefix(),
    queuedAt: new Date().toISOString(),
    retries: 0,
  });
  saveDvirQueue(queue);
}

function removeDvirFromQueue(actionId: string): void {
  const queue = loadDvirQueue().filter((a) => a.id !== actionId);
  saveDvirQueue(queue);
}

function incrementDvirRetry(actionId: string): void {
  const queue = loadDvirQueue().map((a) =>
    a.id === actionId ? { ...a, retries: a.retries + 1 } : a
  );
  saveDvirQueue(queue);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

export async function loadTodayStops(driverId: string): Promise<RouteStop[]> {
  const today = new Date().toISOString().slice(0, 10);

  const { data, error } = await supabase
    .from('v_driver_dispatch_stops')
    .select(
      'stop_id,route_id,driver_id,route_date,route_status,sequence_order,stop_type,stop_status,' +
        'contract_line_id,asset_id,address,address_lat,address_lng,customer_name,job_site_name,' +
        'contact_name,contact_phone,' +
        'notes,signature,condition_notes,photo_paths,departed_at,arrived_at,completed_at,' +
        'telemetry_position_status,eld_compliance_status,driver_log_status,telemetry_event_at,' +
        'dvir_submitted,exception_count'
    )
    .eq('driver_id', driverId)
    .eq('route_date', today)
    .order('sequence_order');

  if (error) {
    throw error;
  }

  const rows = (data ?? []) as unknown as DriverDispatchStopRow[];

  return rows.map((row) => ({
    stopId: row.stop_id ?? '',
    routeId: row.route_id ?? '',
    routeDate: row.route_date ?? '',
    routeStatus: row.route_status ?? 'pending',
    sequenceOrder: row.sequence_order ?? 0,
    stopType: row.stop_type ?? 'delivery',
    stopStatus: row.stop_status ?? 'pending',
    contractLineId: row.contract_line_id ?? null,
    assetId: row.asset_id ?? null,
    address: row.address ?? null,
    addressLat: row.address_lat ?? null,
    addressLng: row.address_lng ?? null,
    customerName: row.customer_name ?? null,
    jobSiteName: row.job_site_name ?? null,
    contactName: row.contact_name ?? null,
    contactPhone: row.contact_phone ?? null,
    notes: row.notes ?? null,
    signature: row.signature ?? null,
    conditionNotes: row.condition_notes ?? null,
    photoPaths: row.photo_paths ?? [],
    departedAt: row.departed_at ?? null,
    arrivedAt: row.arrived_at ?? null,
    completedAt: row.completed_at ?? null,
    telemetryPositionStatus: row.telemetry_position_status ?? 'unknown',
    eldComplianceStatus: row.eld_compliance_status ?? 'unknown',
    driverLogStatus: row.driver_log_status ?? 'unknown',
    telemetryEventAt: row.telemetry_event_at ?? null,
    dvirSubmitted: Boolean(row.dvir_submitted),
    exceptionCount: row.exception_count ?? 0,
  }));
}

/** Upload photos to storage and return their paths. */
async function uploadStopPhotos(stopId: string, files: File[]): Promise<string[]> {
  const paths: string[] = [];
  const safeStopId = sanitizeStoragePathSegment(stopId);
  for (const file of files) {
    const uploadPath = `dispatch-stops/${safeStopId}/${createUploadKeyPrefix()}-${sanitizeUploadFilename(file.name)}`;
    const { error } = await supabase.storage.from('field-evidence').upload(uploadPath, file);
    if (error) {
      throw new Error(`Photo upload failed: ${error.message}`);
    }
    paths.push(uploadPath);
  }
  return paths;
}

/** Advance a stop's status via the RPC; handles connectivity errors by queuing. */
async function advanceStopOnline(
  stopId: string,
  targetStatus: StopStatus,
  signature: string,
  conditionNotes: string,
  photoPaths: string[]
): Promise<void> {
  const { error } = await supabase.rpc('update_route_stop_state', {
    p_stop_id: stopId,
    p_status: targetStatus,
    p_signature: signature.trim() || null,
    p_condition_notes: conditionNotes.trim() || null,
    p_photo_paths: photoPaths.length > 0 ? photoPaths : null,
  });
  if (error) {
    throw error;
  }
}

/** Submit a pre-trip DVIR for the driver's current route. */
async function submitDvirOnline(
  routeId: string,
  truckId: string,
  odometerReading: string,
  defects: Array<{ item: string; severity: string }>,
  isSafeToDrive: boolean,
  notes: string,
  signature: string
): Promise<string> {
  const { data, error } = await supabase.rpc('submit_dvir', {
    p_route_id: routeId,
    p_truck_id: truckId.trim() || null,
    p_odometer_reading: odometerReading.trim() ? parseFloat(odometerReading) : null,
    p_defects: defects.length > 0 ? defects : [],
    p_is_safe_to_drive: isSafeToDrive,
    p_notes: notes.trim() || null,
    p_signature: signature.trim() || null,
  });
  if (error) {
    throw error;
  }
  return data as string;
}

/** Upload exception photos and return their storage paths. */
async function uploadExceptionPhotos(stopId: string, files: File[]): Promise<string[]> {
  const paths: string[] = [];
  const safeStopId = sanitizeStoragePathSegment(stopId);
  for (const file of files) {
    const uploadPath = `dispatch-stops/${safeStopId}/exc-${createUploadKeyPrefix()}-${sanitizeUploadFilename(file.name)}`;
    const { error } = await supabase.storage.from('field-evidence').upload(uploadPath, file);
    if (error) {
      throw new Error(`Exception photo upload failed: ${error.message}`);
    }
    paths.push(uploadPath);
  }
  return paths;
}

/** Submit a route stop exception (ETA, access, damage, or missing attachment). */
async function submitStopExceptionOnline(
  stopId: string,
  exceptionType: ExceptionType,
  notes: string,
  photoPaths: string[],
  estimatedDelayMinutes: number | null
): Promise<string> {
  const { data, error } = await supabase.rpc('submit_stop_exception', {
    p_stop_id: stopId,
    p_exception_type: exceptionType,
    p_notes: notes.trim() || null,
    p_photo_paths: photoPaths.length > 0 ? photoPaths : [],
    p_estimated_delay_minutes: estimatedDelayMinutes ?? null,
  });
  if (error) {
    throw error;
  }
  return data as string;
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/field/dispatch')({
  component: DriverDispatchScreen,
});

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DriverDispatchScreen() {
  const { profile } = useAuth();
  const userCanOperate = canOperate(profile?.role);

  const [stops, setStops] = useState<RouteStop[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [queuedCount, setQueuedCount] = useState(0);

  // Per-stop form state for the active action panel.
  const [activeStopId, setActiveStopId] = useState<string | null>(null);
  const [signature, setSignature] = useState('');
  const [conditionNotes, setConditionNotes] = useState('');
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [actionStatus, setActionStatus] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Location capture.
  const [locationLabel, setLocationLabel] = useState<string>('Not captured');
  const [locationStatus, setLocationStatus] = useState<string>('Location capture optional');

  // DVIR state — pre-trip inspection panel.
  const [showDvir, setShowDvir] = useState(false);
  const [dvirTruckId, setDvirTruckId] = useState('');
  const [dvirOdometer, setDvirOdometer] = useState('');
  const [dvirIsSafe, setDvirIsSafe] = useState(true);
  const [dvirDefects, setDvirDefects] = useState<DvirDefect[]>([]);
  const [dvirNewDefectItem, setDvirNewDefectItem] = useState('');
  const [dvirNewDefectSeverity, setDvirNewDefectSeverity] = useState<DvirDefectSeverity>('minor');
  const [dvirNotes, setDvirNotes] = useState('');
  const [dvirSignature, setDvirSignature] = useState('');
  const [dvirStatus, setDvirStatus] = useState<string | null>(null);
  const [isDvirSubmitting, setIsDvirSubmitting] = useState(false);
  // Tracks routeIds that have a DVIR queued locally (survives offline saves until replayed).
  const [queuedDvirRouteIds, setQueuedDvirRouteIds] = useState<ReadonlySet<string>>(
    () => new Set(loadDvirQueue().map((a) => a.routeId))
  );

  // Per-stop exception state.
  const [exceptionStopId, setExceptionStopId] = useState<string | null>(null);
  const [exceptionType, setExceptionType] = useState<ExceptionType>('eta_delay');
  const [exceptionNotes, setExceptionNotes] = useState('');
  const [exceptionPhotoFiles, setExceptionPhotoFiles] = useState<File[]>([]);
  const [exceptionDelayMin, setExceptionDelayMin] = useState('');
  const [exceptionStatus, setExceptionStatus] = useState<string | null>(null);
  const [isExceptionSubmitting, setIsExceptionSubmitting] = useState(false);
  // Persists a per-stop success confirmation outside the toggleable exception panel.
  const [exceptionConfirmation, setExceptionConfirmation] = useState<Record<string, string>>({});

  const exceptionPhotoInputRef = useRef<HTMLInputElement>(null);

  const photoInputRef = useRef<HTMLInputElement>(null);

  // ── Load stops ─────────────────────────────────────────────────────────────

  const refreshStops = useCallback(async () => {
    if (!profile?.id) return;
    setIsLoading(true);
    setLoadError(null);
    try {
      const data = await loadTodayStops(profile.id);
      setStops(applyQueuedStopActions(data, loadQueue()));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load stops.');
    } finally {
      setIsLoading(false);
    }
  }, [profile?.id]);

  useEffect(() => {
    void refreshStops();
  }, [refreshStops]);

  // ── Online/offline listeners ────────────────────────────────────────────────

  useEffect(() => {
    const syncQueueCount = () => setQueuedCount(loadQueue().length + loadDvirQueue().length);

    const handleOnline = () => {
      setIsOnline(true);
      syncQueueCount();
      void replayQueue();
    };
    const handleOffline = () => {
      setIsOnline(false);
      syncQueueCount();
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    syncQueueCount();

    // Drain any work queued in a previous offline session if we are already online on mount.
    if (navigator.onLine && (loadQueue().length > 0 || loadDvirQueue().length > 0)) {
      void replayQueue();
    }

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Offline queue replay ────────────────────────────────────────────────────

  const replayQueue = useCallback(async () => {
    const queue = loadQueue();
    const dvirQueue = loadDvirQueue();
    if (queue.length === 0 && dvirQueue.length === 0) return;

    for (const action of queue) {
      if (action.retries >= MAX_REPLAY_RETRIES) continue;
      try {
        await advanceStopOnline(
          action.stopId,
          action.targetStatus,
          action.signature,
          action.conditionNotes,
          action.photoPaths
        );
        removeFromQueue(action.id);
      } catch {
        incrementRetry(action.id);
      }
    }

    for (const dvirAction of dvirQueue) {
      if (dvirAction.retries >= MAX_REPLAY_RETRIES) continue;
      try {
        await submitDvirOnline(
          dvirAction.routeId,
          dvirAction.truckId,
          dvirAction.odometerReading,
          dvirAction.defects,
          dvirAction.isSafeToDrive,
          dvirAction.notes,
          dvirAction.signature
        );
        removeDvirFromQueue(dvirAction.id);
        setQueuedDvirRouteIds((prev) => {
          const next = new Set(prev);
          next.delete(dvirAction.routeId);
          return next;
        });
      } catch {
        incrementDvirRetry(dvirAction.id);
      }
    }

    setQueuedCount(loadQueue().length + loadDvirQueue().length);
    await refreshStops();
  }, [refreshStops]);

  // ── Location capture ────────────────────────────────────────────────────────

  const captureLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setLocationStatus('Geolocation not supported by this device.');
      return;
    }
    setLocationStatus('Capturing location…');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lat = pos.coords.latitude.toFixed(5);
        const lng = pos.coords.longitude.toFixed(5);
        setLocationLabel(`${lat}, ${lng}`);
        setLocationStatus('Location captured.');
      },
      (err) => {
        if (err.code === 1) {
          setLocationStatus('Location access denied.');
        } else {
          setLocationStatus('Location unavailable.');
        }
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: LOCATION_TIMEOUT_MS }
    );
  }, []);

  // ── Per-stop action form ────────────────────────────────────────────────────

  function openActionPanel(stopId: string) {
    if (activeStopId === stopId) {
      setActiveStopId(null);
      return;
    }
    setActiveStopId(stopId);
    setSignature('');
    setConditionNotes('');
    setPhotoFiles([]);
    setActionStatus(null);
    setLocationLabel('Not captured');
    setLocationStatus('Location capture optional');
    // Clear exception panel when switching stops.
    setExceptionStopId(null);
    setExceptionStatus(null);
  }

  function openExceptionPanel(stopId: string) {
    if (exceptionStopId === stopId) {
      setExceptionStopId(null);
      return;
    }
    setExceptionStopId(stopId);
    setExceptionType('eta_delay');
    setExceptionNotes('');
    setExceptionPhotoFiles([]);
    setExceptionDelayMin('');
    setExceptionStatus(null);
  }

  async function handleSubmitDvir(routeId: string) {
    if (!userCanOperate) {
      setDvirStatus('Your role does not have permission to submit a DVIR.');
      return;
    }
    if (!dvirSignature.trim()) {
      setDvirStatus('Driver signature is required before submitting DVIR.');
      return;
    }
    setIsDvirSubmitting(true);
    setDvirStatus(null);
    try {
      if (!isOnline) {
        enqueueDvirAction({
          routeId,
          truckId: dvirTruckId,
          odometerReading: dvirOdometer,
          defects: dvirDefects,
          isSafeToDrive: dvirIsSafe,
          notes: dvirNotes,
          signature: dvirSignature,
        });
        setQueuedDvirRouteIds((prev) => new Set([...prev, routeId]));
        setQueuedCount(loadQueue().length + loadDvirQueue().length);
        setDvirStatus('DVIR saved offline — will sync automatically when connection is restored.');
        setShowDvir(false);
        setDvirDefects([]);
        return;
      }
      await submitDvirOnline(
        routeId,
        dvirTruckId,
        dvirOdometer,
        dvirDefects,
        dvirIsSafe,
        dvirNotes,
        dvirSignature
      );
      if (!dvirIsSafe) {
        setDvirStatus('DVIR submitted — safety exception flagged for branch review. Do not depart until cleared.');
      } else {
        setDvirStatus('DVIR submitted — truck cleared for departure.');
      }
      setShowDvir(false);
      setDvirDefects([]);
      await refreshStops();
    } catch (err) {
      setDvirStatus(`Error: ${err instanceof Error ? err.message : 'DVIR submission failed.'}`);
    } finally {
      setIsDvirSubmitting(false);
    }
  }

  async function handleSubmitException(stop: RouteStop) {
    if (!userCanOperate) {
      setExceptionStatus('Your role does not have permission to submit an exception.');
      return;
    }
    setIsExceptionSubmitting(true);
    setExceptionStatus(null);
    try {
      let uploadedPaths: string[] = [];
      if (exceptionPhotoFiles.length > 0 && isOnline) {
        uploadedPaths = await uploadExceptionPhotos(stop.stopId, exceptionPhotoFiles);
      }
      const delayMin = exceptionDelayMin.trim() ? parseInt(exceptionDelayMin, 10) : null;
      await submitStopExceptionOnline(
        stop.stopId,
        exceptionType,
        exceptionNotes,
        uploadedPaths,
        delayMin
      );
      const confirmMsg = `${EXCEPTION_TYPE_LABELS[exceptionType]} exception submitted — branch notified for review.`;
      setExceptionStatus(confirmMsg);
      // Persist the confirmation outside the panel so it stays visible after the panel closes.
      setExceptionConfirmation((prev) => ({ ...prev, [stop.stopId]: confirmMsg }));
      setExceptionStopId(null);
      setExceptionNotes('');
      setExceptionPhotoFiles([]);
      setExceptionDelayMin('');
      await refreshStops();
    } catch (err) {
      setExceptionStatus(`Error: ${err instanceof Error ? err.message : 'Exception submission failed.'}`);
    } finally {
      setIsExceptionSubmitting(false);
    }
  }

  async function handleAdvanceStop(stop: RouteStop) {
    const target = nextStopStatus(stop.stopStatus);
    if (!target) return;
    if (!userCanOperate) {
      setActionStatus('Your role does not have permission to execute stops.');
      return;
    }

    setIsSubmitting(true);
    setActionStatus(null);

    try {
      // Upload photos first while we still have connectivity.
      let uploadedPaths: string[] = [];
      if (photoFiles.length > 0 && isOnline) {
        uploadedPaths = await uploadStopPhotos(stop.stopId, photoFiles);
      }

      if (!isOnline) {
        // Queue the action locally for replay.
        enqueueAction({
          stopId: stop.stopId,
          targetStatus: target,
          signature,
          conditionNotes,
          photoPaths: uploadedPaths,
        });
        setQueuedCount(loadQueue().length + loadDvirQueue().length);
        setActionStatus(`Action queued (offline). It will sync automatically when you reconnect.`);
        // Optimistically update local state.
        setStops((prev) =>
          prev.map((s) =>
            s.stopId === stop.stopId
              ? {
                  ...s,
                  stopStatus: target,
                  signature: signature || s.signature,
                  conditionNotes: conditionNotes || s.conditionNotes,
                }
              : s
          )
        );
      } else {
        await advanceStopOnline(stop.stopId, target, signature, conditionNotes, uploadedPaths);
        setActionStatus(`Stop marked as ${STOP_STATUS_LABELS[target]}.`);
        await refreshStops();
      }

      setActiveStopId(null);
      setSignature('');
      setConditionNotes('');
      setPhotoFiles([]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Action failed.';
      if (!isOnline || msg.toLowerCase().includes('network') || msg.toLowerCase().includes('fetch')) {
        enqueueAction({
          stopId: stop.stopId,
          targetStatus: target,
          signature,
          conditionNotes,
          photoPaths: [],
        });
        setQueuedCount(loadQueue().length + loadDvirQueue().length);
        setActionStatus('Offline — action queued for replay on reconnect.');
      } else {
        setActionStatus(`Error: ${msg}`);
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  // ── Render helpers ──────────────────────────────────────────────────────────

  const pendingCount = stops.filter((s) => s.stopStatus === 'pending').length;
  const completedCount = stops.filter((s) => s.stopStatus === 'completed').length;

  // Run-sheet readiness: stops missing address, customer context, or contact.
  const incompleteStops = stops.filter(
    (s) => s.stopStatus === 'pending' && (!s.address || !s.customerName || !s.contactName)
  );

  // DVIR: use route ID from the first stop (all stops share the same route).
  const routeId = stops.length > 0 ? stops[0].routeId : null;
  const dvirSubmitted =
    (stops.length > 0 && stops[0].dvirSubmitted) ||
    (routeId != null && queuedDvirRouteIds.has(routeId));
  const queuedStopIds = new Set(loadQueue().map((action) => action.stopId));

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-10 sm:space-y-6 sm:p-6">
      {/* ── Header card ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="space-y-2 p-4 sm:p-6">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-xl sm:text-2xl">Driver Dispatch</CardTitle>
            {!isOnline && (
              <Badge variant="outline" className="flex items-center gap-1 text-amber-700 border-amber-400">
                <WifiOff className="h-3 w-3" aria-hidden="true" />
                Offline
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            Today&apos;s route &mdash; {stops.length} stop{stops.length !== 1 ? 's' : ''} &bull;{' '}
            {completedCount} completed &bull; {pendingCount} remaining
          </p>
          {queuedCount > 0 && (
            <Alert className="mt-2 border-amber-400 bg-amber-50 text-amber-800">
              <AlertTitle className="text-sm font-semibold">
                {queuedCount} action{queuedCount !== 1 ? 's' : ''} queued offline
              </AlertTitle>
              <AlertDescription className="text-xs">
                These will sync automatically when your connection is restored.
              </AlertDescription>
            </Alert>
          )}
        </CardHeader>
      </Card>

      {/* ── Load / error states ─────────────────────────────────────────── */}
      {isLoading && (
        <p className="text-center text-sm text-muted-foreground" role="status" aria-live="polite">
          Loading stops…
        </p>
      )}
      {loadError && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle>Could not load stops</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}
      {!isLoading && !loadError && stops.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-muted-foreground">
            No stops assigned for today.
          </CardContent>
        </Card>
      )}

      {/* ── Pre-dispatch: run-sheet readiness ──────────────────────────── */}
      {!isLoading && stops.length > 0 && incompleteStops.length > 0 && (
        <Alert className="border-orange-400 bg-orange-50 text-orange-900">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
          <AlertTitle className="text-sm font-semibold">
            {incompleteStops.length} stop{incompleteStops.length !== 1 ? 's' : ''} with incomplete dispatch data
          </AlertTitle>
          <AlertDescription className="text-xs">
            {incompleteStops.map((s, i) => (
              <span key={s.stopId}>
                Stop {s.sequenceOrder + 1}
                {!s.address && ' — missing address'}
                {!s.customerName && ' — missing customer'}
                {!s.contactName && ' — missing contact'}
                {i < incompleteStops.length - 1 ? '; ' : ''}
              </span>
            ))}
            {' '}— resolve with dispatch before departure.
          </AlertDescription>
        </Alert>
      )}

      {/* ── Pre-dispatch: DVIR ──────────────────────────────────────────── */}
      {!isLoading && routeId && (
        <Card>
          <CardHeader className="p-4 sm:p-5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Shield
                  className={`h-4 w-4 ${dvirSubmitted ? 'text-green-600' : 'text-amber-500'}`}
                  aria-hidden="true"
                />
                <CardTitle className="text-base">Pre-trip DVIR</CardTitle>
                {dvirSubmitted ? (
                  <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Completed</Badge>
                ) : (
                  <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">Pending</Badge>
                )}
              </div>
              {!dvirSubmitted && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDvir((v) => !v)}
                  aria-expanded={showDvir}
                >
                  {showDvir ? 'Cancel' : 'Start DVIR'}
                </Button>
              )}
            </div>
            {dvirStatus && (
              <p
                className={`mt-2 text-sm ${dvirStatus.startsWith('Error') ? 'text-red-600' : 'text-green-700'}`}
                role="status"
                aria-live="polite"
              >
                {dvirStatus}
              </p>
            )}
          </CardHeader>

          {showDvir && !dvirSubmitted && (
            <CardContent className="space-y-4 border-t px-4 pb-4 pt-4 sm:px-5 sm:pb-5">
              <div className="space-y-1">
                <Label htmlFor="dvir-truck">Truck / unit ID</Label>
                <Input
                  id="dvir-truck"
                  placeholder="e.g. TRK-042"
                  value={dvirTruckId}
                  onChange={(e) => setDvirTruckId(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="dvir-odometer">Odometer reading</Label>
                <Input
                  id="dvir-odometer"
                  type="number"
                  placeholder="Miles / km"
                  value={dvirOdometer}
                  onChange={(e) => setDvirOdometer(e.target.value)}
                />
              </div>

              {/* Defect capture */}
              <div className="space-y-2">
                <p className="text-sm font-medium">Defects found</p>
                {dvirDefects.length > 0 && (
                  <ul className="space-y-1" aria-label="Added defects">
                    {dvirDefects.map((d, i) => (
                      <li key={i} className="flex items-center justify-between rounded border bg-muted/50 px-3 py-1.5 text-xs">
                        <span>
                          <span className="font-medium">{d.item}</span>
                          {' — '}
                          <span className="capitalize">{d.severity}</span>
                        </span>
                        <button
                          type="button"
                          aria-label={`Remove defect: ${d.item}`}
                          className="ml-2 text-muted-foreground hover:text-red-600"
                          onClick={() => setDvirDefects((prev) => prev.filter((_, j) => j !== i))}
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="flex-1 space-y-1">
                    <Label htmlFor="dvir-defect-item">Defect description</Label>
                    <Input
                      id="dvir-defect-item"
                      placeholder="e.g. Left rear tyre"
                      value={dvirNewDefectItem}
                      onChange={(e) => setDvirNewDefectItem(e.target.value)}
                    />
                  </div>
                  <div className="w-full space-y-1 sm:w-36">
                    <Label htmlFor="dvir-defect-severity">Severity</Label>
                    <Select
                      value={dvirNewDefectSeverity}
                      onValueChange={(v) => setDvirNewDefectSeverity(v as DvirDefectSeverity)}
                    >
                      <SelectTrigger id="dvir-defect-severity">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(DVIR_DEFECT_SEVERITY_LABELS) as DvirDefectSeverity[]).map((s) => (
                          <SelectItem key={s} value={s}>
                            {DVIR_DEFECT_SEVERITY_LABELS[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!dvirNewDefectItem.trim()}
                    onClick={() => {
                      if (!dvirNewDefectItem.trim()) return;
                      setDvirDefects((prev) => [
                        ...prev,
                        { item: dvirNewDefectItem.trim(), severity: dvirNewDefectSeverity },
                      ]);
                      setDvirNewDefectItem('');
                    }}
                  >
                    Add defect
                  </Button>
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="dvir-notes">Defects / inspection notes</Label>
                <Textarea
                  id="dvir-notes"
                  placeholder="Describe any defects or inspection observations not captured above (optional)"
                  rows={3}
                  value={dvirNotes}
                  onChange={(e) => setDvirNotes(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-3">
                <Checkbox
                  id="dvir-safe"
                  checked={dvirIsSafe}
                  onCheckedChange={(checked) => setDvirIsSafe(Boolean(checked))}
                />
                <Label htmlFor="dvir-safe" className="cursor-pointer">
                  Truck is safe to drive
                </Label>
              </div>
              {!dvirIsSafe && (
                <Alert className="border-red-400 bg-red-50 text-red-800">
                  <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                  <AlertDescription className="text-xs">
                    Safety exception will be escalated for branch review. Do not depart until a
                    branch manager clears this DVIR.
                  </AlertDescription>
                </Alert>
              )}
              <div className="space-y-1">
                <Label htmlFor="dvir-sig">Driver signature</Label>
                <Input
                  id="dvir-sig"
                  placeholder="Type your name to sign"
                  value={dvirSignature}
                  onChange={(e) => setDvirSignature(e.target.value)}
                />
              </div>
              <Button
                type="button"
                className="w-full"
                onClick={() => void handleSubmitDvir(routeId)}
                disabled={isDvirSubmitting}
              >
                {isDvirSubmitting ? 'Submitting…' : 'Submit DVIR'}
              </Button>
            </CardContent>
          )}
        </Card>
      )}

      {/* ── Stop list ───────────────────────────────────────────────────── */}
      {stops.map((stop) => {
        const isExpanded = activeStopId === stop.stopId;
        const isDone = stop.stopStatus === 'completed';
        const hasQueuedReplay = queuedStopIds.has(stop.stopId);
        const next = nextStopStatus(stop.stopStatus);
        const routeStatusParts = [
          `ELD ${ELD_STATUS_LABELS[stop.eldComplianceStatus]}`,
          `Driver log ${DRIVER_LOG_LABELS[stop.driverLogStatus]}`,
          `GPS ${TELEMETRY_POSITION_LABELS[stop.telemetryPositionStatus]}`,
          stop.telemetryEventAt ? `Updated ${formatTimestamp(stop.telemetryEventAt)}` : null,
        ].filter(Boolean);

        return (
          <Card
            key={stop.stopId}
            className={isDone ? 'opacity-70' : undefined}
            data-testid={`stop-card-${stop.stopId}`}
          >
            <CardHeader className="p-4 sm:p-5">
              <div className="flex items-start gap-3">
                {/* Sequence badge */}
                <span
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-muted-foreground"
                  aria-label={`Stop ${stop.sequenceOrder + 1}`}
                >
                  {stop.sequenceOrder + 1}
                </span>
                {/* Stop info */}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <StopTypeBadge type={stop.stopType} />
                    <StopStatusBadge status={stop.stopStatus} />
                   {stop.exceptionCount > 0 && (
                     <Badge className="bg-red-100 text-red-800 hover:bg-red-100 flex items-center gap-1">
                       <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                       {stop.exceptionCount} exception{stop.exceptionCount !== 1 ? 's' : ''}
                     </Badge>
                   )}
                   {hasQueuedReplay && (
                     <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">
                       Queued replay
                     </Badge>
                   )}
                  </div>
                  {stop.customerName && (
                    <p className="text-sm font-medium truncate">{stop.customerName}</p>
                  )}
                  {stop.jobSiteName && (
                    <p className="text-xs text-muted-foreground truncate">{stop.jobSiteName}</p>
                  )}
                  {stop.contactName && (
                    <p className="text-xs text-muted-foreground truncate">
                      Contact: {stop.contactName}
                      {stop.contactPhone && (
                        <>
                          {' · '}
                          <a
                            href={`tel:${stop.contactPhone}`}
                            className="text-blue-600 hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {stop.contactPhone}
                          </a>
                        </>
                      )}
                    </p>
                  )}
                  {stop.address && (
                    <p className="text-xs text-muted-foreground truncate">{stop.address}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {routeStatusParts.join(' · ')}
                  </p>
                  {(stop.departedAt || stop.arrivedAt || stop.completedAt) && (
                    <p className="text-xs text-muted-foreground">
                      {stop.departedAt && `Departed ${formatTimestamp(stop.departedAt)}`}
                      {stop.arrivedAt && ` · Arrived ${formatTimestamp(stop.arrivedAt)}`}
                      {stop.completedAt && ` · Completed ${formatTimestamp(stop.completedAt)}`}
                    </p>
                  )}
                </div>
                {/* Expand/collapse button */}
                {!isDone && (
                  <button
                    type="button"
                    aria-expanded={isExpanded}
                    aria-controls={`stop-panel-${stop.stopId}`}
                    className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted"
                    onClick={() => openActionPanel(stop.stopId)}
                  >
                    {isExpanded ? (
                      <ChevronUp className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="h-4 w-4" aria-hidden="true" />
                    )}
                    <span className="sr-only">{isExpanded ? 'Collapse' : 'Expand'} stop actions</span>
                  </button>
                )}
                {isDone && <CheckCircle2 className="h-5 w-5 shrink-0 text-green-600" aria-hidden="true" />}
              </div>

              {/* Navigation handoff */}
              {stop.address && !isDone && (
                <div className="mt-2 pl-10">
                  <a
                    href={buildMapsUrl(stop.address, stop.addressLat, stop.addressLng)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:underline"
                  >
                    <Navigation className="h-3 w-3" aria-hidden="true" />
                    Navigate to stop
                  </a>
                </div>
              )}

              {/* Completed stop: evidence summary + proof link */}
              {isDone && (
                <div className="mt-2 pl-10 flex flex-wrap items-center gap-3">
                  <a
                    href={`/field/pod?stop=${stop.stopId}`}
                    className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                    aria-label="View proof record for this stop"
                  >
                    View proof
                  </a>
                  {stop.signature && (
                    <span className="text-xs text-muted-foreground" aria-label="Signature captured">
                      ✓ Signature
                    </span>
                  )}
                  {stop.conditionNotes && (
                    <span className="text-xs text-muted-foreground">Condition: {stop.conditionNotes}</span>
                  )}
                  {stop.photoPaths.length > 0 && (
                    <span
                      className="text-xs text-muted-foreground"
                      aria-label={`${stop.photoPaths.length} photo${stop.photoPaths.length !== 1 ? 's' : ''} attached`}
                    >
                      ✓ {stop.photoPaths.length} photo{stop.photoPaths.length !== 1 ? 's' : ''}
                    </span>
                  )}
                  {!stop.signature && (
                    <span className="text-xs text-amber-600" aria-label="Evidence incomplete, needs review">
                      ⚠ Needs review
                    </span>
                  )}
                </div>
              )}

              {/* Pre-existing notes from dispatcher */}
              {stop.notes && (
                <p className="mt-2 pl-10 text-xs text-muted-foreground italic">{stop.notes}</p>
              )}
            </CardHeader>

            {/* ── Action panel (expanded) ─────────────────────────────── */}
            {isExpanded && (
              <CardContent
                id={`stop-panel-${stop.stopId}`}
                className="space-y-4 border-t px-4 pb-4 pt-4 sm:px-5 sm:pb-5"
              >
                {/* Signature (required for completion) */}
                {next === 'completed' && (
                  <div className="space-y-1">
                    <Label htmlFor={`sig-${stop.stopId}`}>Signature</Label>
                    <Input
                      id={`sig-${stop.stopId}`}
                      placeholder="Type your name as captured signature"
                      value={signature}
                      onChange={(e) => setSignature(e.target.value)}
                    />
                  </div>
                )}

                {/* Condition notes */}
                {next === 'completed' && (
                  <div className="space-y-1">
                    <Label htmlFor={`cond-${stop.stopId}`}>Condition notes</Label>
                    <Textarea
                      id={`cond-${stop.stopId}`}
                      placeholder="Asset condition, damage, or delivery notes (optional)"
                      rows={3}
                      value={conditionNotes}
                      onChange={(e) => setConditionNotes(e.target.value)}
                    />
                  </div>
                )}

                {/* Photo capture */}
                {next === 'completed' && (
                  <div className="space-y-1">
                    <Label htmlFor={`photos-${stop.stopId}`}>Photos</Label>
                    <div className="flex items-center gap-2">
                      <input
                        ref={photoInputRef}
                        id={`photos-${stop.stopId}`}
                        type="file"
                        accept="image/*"
                        multiple
                        capture="environment"
                        className="sr-only"
                        onChange={(e) => {
                          if (e.target.files) {
                            setPhotoFiles(Array.from(e.target.files));
                          }
                        }}
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => photoInputRef.current?.click()}
                      >
                        {photoFiles.length > 0 ? `${photoFiles.length} photo(s) selected` : 'Add photos'}
                      </Button>
                      {photoFiles.length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground"
                          onClick={() => setPhotoFiles([])}
                        >
                          Clear
                        </Button>
                      )}
                    </div>
                  </div>
                )}

                {/* Location capture */}
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    <span className="text-xs text-muted-foreground">
                      {locationLabel} &mdash; {locationStatus}
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    onClick={captureLocation}
                  >
                    Capture location
                  </Button>
                </div>

                {/* Action feedback */}
                {actionStatus && (
                  <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
                    {actionStatus}
                  </p>
                )}

                {/* Advance button */}
                {next && (
                  <Button
                    type="button"
                    className="w-full"
                    onClick={() => void handleAdvanceStop(stop)}
                    disabled={isSubmitting || !userCanOperate}
                  >
                    <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
                    {isSubmitting ? 'Saving…' : `Mark as ${STOP_STATUS_LABELS[next]}`}
                  </Button>
                )}

                {/* ── Exception / escalation panel ───────────────────── */}
                <div className="border-t pt-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="flex items-center gap-1 text-amber-700 border-amber-400 w-full sm:w-auto"
                    onClick={() => openExceptionPanel(stop.stopId)}
                    aria-expanded={exceptionStopId === stop.stopId}
                  >
                    <Clock className="h-3.5 w-3.5" aria-hidden="true" />
                    {exceptionStopId === stop.stopId ? 'Cancel exception' : 'Report exception / ETA'}
                  </Button>
                  {/* Persistent confirmation shown after a successful exception submission. */}
                  {exceptionConfirmation[stop.stopId] && (
                    <p
                      className="mt-2 text-xs text-green-700"
                      role="status"
                      aria-live="polite"
                    >
                      {exceptionConfirmation[stop.stopId]}
                    </p>
                  )}
                </div>

                {exceptionStopId === stop.stopId && (
                  <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3">
                    <p className="text-xs font-semibold text-amber-800">
                      Report an exception — branch will review and action (no auto-disposition).
                    </p>
                    <div className="space-y-1">
                      <Label htmlFor={`exc-type-${stop.stopId}`}>Exception type</Label>
                      <Select
                        value={exceptionType}
                        onValueChange={(v) => setExceptionType(v as ExceptionType)}
                      >
                        <SelectTrigger id={`exc-type-${stop.stopId}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(Object.keys(EXCEPTION_TYPE_LABELS) as ExceptionType[]).map((t) => (
                            <SelectItem key={t} value={t}>
                              {EXCEPTION_TYPE_LABELS[t]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {exceptionType === 'eta_delay' && (
                      <div className="space-y-1">
                        <Label htmlFor={`exc-delay-${stop.stopId}`}>Estimated delay (minutes)</Label>
                        <Input
                          id={`exc-delay-${stop.stopId}`}
                          type="number"
                          min={1}
                          placeholder="e.g. 30"
                          value={exceptionDelayMin}
                          onChange={(e) => setExceptionDelayMin(e.target.value)}
                        />
                      </div>
                    )}

                    <div className="space-y-1">
                      <Label htmlFor={`exc-notes-${stop.stopId}`}>Notes</Label>
                      <Textarea
                        id={`exc-notes-${stop.stopId}`}
                        placeholder={
                          exceptionType === 'damage'
                            ? 'Describe damage — item, extent, and when noticed'
                            : exceptionType === 'missing_attachment'
                            ? 'Describe missing attachment or accessory'
                            : exceptionType === 'access_issue'
                            ? 'Describe access problem (gate, contact, road)'
                            : 'Describe delay cause and current ETA'
                        }
                        rows={3}
                        value={exceptionNotes}
                        onChange={(e) => setExceptionNotes(e.target.value)}
                      />
                    </div>

                    {(exceptionType === 'damage' || exceptionType === 'missing_attachment') && (
                      <div className="space-y-1">
                        <Label htmlFor={`exc-photos-${stop.stopId}`}>Evidence photos</Label>
                        <div className="flex items-center gap-2">
                          <input
                            ref={exceptionPhotoInputRef}
                            id={`exc-photos-${stop.stopId}`}
                            type="file"
                            accept="image/*"
                            multiple
                            capture="environment"
                            className="sr-only"
                            onChange={(e) => {
                              if (e.target.files) {
                                setExceptionPhotoFiles(Array.from(e.target.files));
                              }
                            }}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => exceptionPhotoInputRef.current?.click()}
                          >
                            {exceptionPhotoFiles.length > 0
                              ? `${exceptionPhotoFiles.length} photo(s) selected`
                              : 'Add evidence photos'}
                          </Button>
                          {exceptionPhotoFiles.length > 0 && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground"
                              onClick={() => setExceptionPhotoFiles([])}
                            >
                              Clear
                            </Button>
                          )}
                        </div>
                      </div>
                    )}

                    {exceptionStatus && (
                      <p
                        className={`text-xs ${exceptionStatus.startsWith('Error') ? 'text-red-600' : 'text-green-700'}`}
                        role="status"
                        aria-live="polite"
                      >
                        {exceptionStatus}
                      </p>
                    )}

                    <Button
                      type="button"
                      size="sm"
                      className="w-full"
                      onClick={() => void handleSubmitException(stop)}
                      disabled={isExceptionSubmitting || !userCanOperate}
                    >
                      {isExceptionSubmitting ? 'Submitting…' : 'Submit exception'}
                    </Button>
                  </div>
                )}
              </CardContent>
            )}
          </Card>
        );
      })}

      {/* ── Global status message ────────────────────────────────────────── */}
      {actionStatus && activeStopId === null && (
        <p className="text-center text-sm text-muted-foreground" role="status" aria-live="polite">
          {actionStatus}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small presentational components
// ---------------------------------------------------------------------------

function StopTypeBadge({ type }: { type: StopType }) {
  if (type === 'delivery') {
    return (
      <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100 flex items-center gap-1">
        <Truck className="h-3 w-3" aria-hidden="true" />
        Delivery
      </Badge>
    );
  }
  return (
    <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 flex items-center gap-1">
      <Package className="h-3 w-3" aria-hidden="true" />
      Pickup
    </Badge>
  );
}

function StopStatusBadge({ status }: { status: StopStatus }) {
  const variants: Record<StopStatus, string> = {
    pending: 'bg-gray-100 text-gray-700 hover:bg-gray-100',
    departed: 'bg-indigo-100 text-indigo-800 hover:bg-indigo-100',
    arrived: 'bg-yellow-100 text-yellow-800 hover:bg-yellow-100',
    completed: 'bg-green-100 text-green-800 hover:bg-green-100',
  };
  return <Badge className={variants[status]}>{STOP_STATUS_LABELS[status]}</Badge>;
}
