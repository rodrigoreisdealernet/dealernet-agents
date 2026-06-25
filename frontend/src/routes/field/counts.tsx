import { useCallback, useEffect, useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/auth/AuthContext';
import { canOperate } from '@/auth/types';
import { supabase } from '@/data/supabase';

export const Route = createFileRoute('/field/counts')({
  component: RapidCountCapturePage,
});

function RapidCountCapturePage() {
  return <RapidCountCaptureScreen />;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type CountTaskStatus = 'planned' | 'in_progress' | 'submitted' | 'approved' | 'closed';
type ScanMethod = 'barcode' | 'rfid' | 'manual';

interface CountTask {
  count_task_id: string;
  task_name: string;
  description: string | null;
  status: CountTaskStatus;
  branch_name: string | null;
  location_name: string | null;
  assignee_name: string | null;
  due_date: string | null;
  count_type: string | null;
}

interface CountLine {
  line_id: string;
  count_task_id: string;
  captured_at: string;
  scan_value: string;
  scan_method: string;
  quantity: number;
  item_description: string | null;
  captured_by: string | null;
  idempotency_key: string;
}

interface OfflineQueueEntry {
  idempotency_key: string;
  count_task_id: string;
  scan_value: string;
  scan_method: ScanMethod;
  quantity: number;
  item_description: string;
  queued_at: string;
  attempt_at: string | null;
  status: 'pending' | 'failed' | 'synced';
  error: string | null;
}

interface CaptureFormState {
  scanValue: string;
  quantity: string;
  itemDescription: string;
  scanMethod: ScanMethod;
}

const OFFLINE_QUEUE_KEY = 'rapidcount_offline_queue';

const INITIAL_FORM: CaptureFormState = {
  scanValue: '',
  quantity: '1',
  itemDescription: '',
  scanMethod: 'barcode',
};

// ---------------------------------------------------------------------------
// Offline queue helpers (localStorage-backed browser fallback)
// ---------------------------------------------------------------------------

function loadOfflineQueue(): OfflineQueueEntry[] {
  try {
    const raw = localStorage.getItem(OFFLINE_QUEUE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as OfflineQueueEntry[];
  } catch {
    return [];
  }
}

function saveOfflineQueue(queue: OfflineQueueEntry[]): void {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Storage quota exceeded — continue without persistence.
  }
}

function generateIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Data fetch helpers
// ---------------------------------------------------------------------------

async function fetchMyCountTasks(assigneeName: string): Promise<CountTask[]> {
  const { data, error } = await supabase
    .from('rapidcount_count_tasks_current')
    .select('*')
    .order('due_date', { ascending: true });

  if (error) throw error;

  const rows = (data || []) as Array<Record<string, unknown>>;
  return rows
    .filter((row) => {
      const status = String(row.status || '');
      return status !== 'approved' && status !== 'closed';
    })
    .filter((row) => {
      const rowAssignee = String(row.assignee_name || '').toLowerCase();
      return rowAssignee === assigneeName.toLowerCase();
    })
    .map((row) => ({
      count_task_id: String(row.count_task_id || ''),
      task_name: String(row.task_name || 'Untitled Count Task'),
      description: typeof row.description === 'string' ? row.description : null,
      status: (row.status as CountTaskStatus) || 'planned',
      branch_name: typeof row.branch_name === 'string' ? row.branch_name : null,
      location_name: typeof row.location_name === 'string' ? row.location_name : null,
      assignee_name: typeof row.assignee_name === 'string' ? row.assignee_name : null,
      due_date: typeof row.due_date === 'string' ? row.due_date : null,
      count_type: typeof row.count_type === 'string' ? row.count_type : null,
    }));
}

async function fetchCountLines(countTaskId: string): Promise<CountLine[]> {
  const { data, error } = await supabase
    .from('rapidcount_count_lines_current')
    .select('*')
    .eq('count_task_id', countTaskId)
    .order('captured_at', { ascending: false });

  if (error) throw error;

  return ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    line_id: String(row.line_id || ''),
    count_task_id: String(row.count_task_id || ''),
    captured_at: String(row.captured_at || ''),
    scan_value: String(row.scan_value || ''),
    scan_method: String(row.scan_method || 'manual'),
    quantity: typeof row.quantity === 'number' ? row.quantity : Number(row.quantity ?? 1),
    item_description: typeof row.item_description === 'string' ? row.item_description : null,
    captured_by: typeof row.captured_by === 'string' ? row.captured_by : null,
    idempotency_key: String(row.idempotency_key || ''),
  }));
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

function formatDate(value: string | null | undefined): string {
  if (!value) return 'No due date';
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString();
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function statusVariant(status: CountTaskStatus): 'secondary' | 'outline' | 'destructive' {
  if (status === 'in_progress') return 'secondary';
  if (status === 'submitted' || status === 'approved') return 'outline';
  return 'outline';
}

// ---------------------------------------------------------------------------
// Main screen component (exported for tests)
// ---------------------------------------------------------------------------

export function RapidCountCaptureScreen() {
  const { profile } = useAuth();
  const [tasks, setTasks] = useState<CountTask[]>([]);
  const [activeTask, setActiveTask] = useState<CountTask | null>(null);
  const [lines, setLines] = useState<CountLine[]>([]);
  const [form, setForm] = useState<CaptureFormState>(INITIAL_FORM);
  const [offlineQueue, setOfflineQueue] = useState<OfflineQueueEntry[]>([]);
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [isReplaying, setIsReplaying] = useState(false);
  const scanInputRef = useRef<HTMLInputElement>(null);

  // RFID is not natively available in the browser runtime.
  const rfidUnsupported = true;

  // ---------------------------------------------------------------------------
  // Connectivity tracking
  // ---------------------------------------------------------------------------

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
    }
    function handleOffline() {
      setIsOnline(false);
    }
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // Auto-replay offline queue when connectivity returns.
  useEffect(() => {
    if (isOnline) {
      const pending = loadOfflineQueue().filter((e) => e.status === 'pending');
      if (pending.length > 0) {
        void replayOfflineQueue();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline]);

  // ---------------------------------------------------------------------------
  // Load offline queue from localStorage on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    setOfflineQueue(loadOfflineQueue());
  }, []);

  // ---------------------------------------------------------------------------
  // Load tasks
  // ---------------------------------------------------------------------------

  const loadTasks = useCallback(async () => {
    if (!profile?.displayName) return;
    setLoadError(null);
    try {
      const fetched = await fetchMyCountTasks(profile.displayName);
      setTasks(fetched);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load count tasks');
    }
  }, [profile?.displayName]);

  useEffect(() => {
    void loadTasks();
  }, [loadTasks]);

  // ---------------------------------------------------------------------------
  // Reload lines when active task changes
  // ---------------------------------------------------------------------------

  const loadLines = useCallback(async (taskId: string) => {
    try {
      const fetched = await fetchCountLines(taskId);
      setLines(fetched);
    } catch {
      // Non-blocking — captured items are still staged in offline queue.
    }
  }, []);

  useEffect(() => {
    if (activeTask) {
      void loadLines(activeTask.count_task_id);
    } else {
      setLines([]);
    }
  }, [activeTask, loadLines]);

  // ---------------------------------------------------------------------------
  // Start a task (planned → in_progress)
  // ---------------------------------------------------------------------------

  async function startTask(task: CountTask) {
    if (task.status !== 'planned') {
      setActiveTask(task);
      return;
    }
    setIsStarting(true);
    setCaptureError(null);
    try {
      const { error } = await supabase.rpc('rapidcount_start_count_task', {
        p_count_task_id: task.count_task_id,
      });
      if (error) throw error;
      const updated: CountTask = { ...task, status: 'in_progress' };
      setTasks((prev) => prev.map((t) => (t.count_task_id === task.count_task_id ? updated : t)));
      setActiveTask(updated);
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : 'Failed to start count task');
    } finally {
      setIsStarting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Capture a count line
  // ---------------------------------------------------------------------------

  async function handleCapture(e: React.FormEvent) {
    e.preventDefault();
    const scanValue = form.scanValue.trim();
    if (!scanValue) {
      setCaptureError('Scan value is required');
      return;
    }
    if (!activeTask) return;

    const qty = parseInt(form.quantity, 10);
    if (Number.isNaN(qty) || qty < 1) {
      setCaptureError('Quantity must be a positive number');
      return;
    }

    setCaptureError(null);
    const idempotency_key = generateIdempotencyKey();
    const entry: OfflineQueueEntry = {
      idempotency_key,
      count_task_id: activeTask.count_task_id,
      scan_value: scanValue,
      scan_method: form.scanMethod,
      quantity: qty,
      item_description: form.itemDescription.trim(),
      queued_at: new Date().toISOString(),
      attempt_at: null,
      status: 'pending',
      error: null,
    };

    if (!isOnline) {
      // Stage offline — persist to local queue.
      const updated = [...offlineQueue, entry];
      setOfflineQueue(updated);
      saveOfflineQueue(updated);
      setForm(INITIAL_FORM);
      scanInputRef.current?.focus();
      return;
    }

    setIsCapturing(true);
    try {
      const { error } = await supabase.rpc('rapidcount_capture_count_line', {
        p_count_task_id: activeTask.count_task_id,
        p_idempotency_key: idempotency_key,
        p_scan_value: scanValue,
        p_scan_method: form.scanMethod,
        p_quantity: qty,
        p_item_description: form.itemDescription.trim() || null,
      });
      if (error) throw error;
      setForm(INITIAL_FORM);
      scanInputRef.current?.focus();
      await loadLines(activeTask.count_task_id);
    } catch (err) {
      // On failure, fall back to offline staging.
      const failedEntry: OfflineQueueEntry = {
        ...entry,
        attempt_at: new Date().toISOString(),
        status: 'failed',
        error: err instanceof Error ? err.message : 'Capture failed',
      };
      const updated = [...offlineQueue, failedEntry];
      setOfflineQueue(updated);
      saveOfflineQueue(updated);
      setSyncError(failedEntry.error);
    } finally {
      setIsCapturing(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Replay offline queue
  // ---------------------------------------------------------------------------

  const replayOfflineQueue = useCallback(async () => {
    const queue = loadOfflineQueue();
    const pending = queue.filter((e) => e.status === 'pending');
    if (pending.length === 0) return;

    setIsReplaying(true);
    setSyncError(null);

    let failedCount = 0;
    const updated = [...queue];

    for (const entry of pending) {
      const idx = updated.findIndex((e) => e.idempotency_key === entry.idempotency_key);
      try {
        const { error } = await supabase.rpc('rapidcount_capture_count_line', {
          p_count_task_id: entry.count_task_id,
          p_idempotency_key: entry.idempotency_key,
          p_scan_value: entry.scan_value,
          p_scan_method: entry.scan_method,
          p_quantity: entry.quantity,
          p_item_description: entry.item_description || null,
        });
        if (error) throw error;
        updated[idx] = { ...entry, status: 'synced', attempt_at: new Date().toISOString() };
      } catch (err) {
        failedCount++;
        updated[idx] = {
          ...entry,
          status: 'failed',
          attempt_at: new Date().toISOString(),
          error: err instanceof Error ? err.message : 'Sync failed',
        };
      }
    }

    // Retain failed entries so operators can see them; remove synced ones.
    const retained = updated.filter((e) => e.status !== 'synced');
    setOfflineQueue(retained);
    saveOfflineQueue(retained);

    if (failedCount > 0) {
      setSyncError(`${failedCount} item(s) could not be synced. Check connectivity and retry.`);
    }

    if (activeTask) {
      await loadLines(activeTask.count_task_id);
    }

    setIsReplaying(false);
  }, [activeTask, loadLines]);

  // ---------------------------------------------------------------------------
  // Guard: only operators and above can use this screen
  // ---------------------------------------------------------------------------

  if (!canOperate(profile?.role)) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Access restricted</AlertTitle>
        <AlertDescription>Only field operators, branch managers, and admins can capture count data.</AlertDescription>
      </Alert>
    );
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const pendingCount = offlineQueue.filter((e) => e.status === 'pending').length;
  const failedCount = offlineQueue.filter((e) => e.status === 'failed').length;

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">RapidCount Capture</h1>
        <p className="text-sm text-muted-foreground">
          Start your assigned count task and capture items by barcode, RFID, or manual entry.
        </p>
      </div>

      {/* Connectivity banner */}
      {!isOnline ? (
        <Alert>
          <AlertTitle>You are offline</AlertTitle>
          <AlertDescription>
            Captures will be staged locally and synced automatically when connectivity returns.
            {pendingCount > 0 ? ` ${pendingCount} item(s) queued.` : ''}
          </AlertDescription>
        </Alert>
      ) : null}

      {/* Sync failure banner */}
      {syncError ? (
        <Alert variant="destructive">
          <AlertTitle>Sync failure</AlertTitle>
          <AlertDescription>
            {syncError}{' '}
            <Button
              variant="link"
              className="h-auto p-0 text-destructive-foreground underline"
              onClick={() => void replayOfflineQueue()}
              disabled={isReplaying}
            >
              {isReplaying ? 'Retrying…' : 'Retry now'}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {/* RFID unsupported banner (always shown in browser runtime) */}
      {rfidUnsupported ? (
        <Alert>
          <AlertTitle>RFID scanning unavailable</AlertTitle>
          <AlertDescription>
            RFID capture requires the native mobile app. Use barcode scanning or manual entry in
            this browser session.
          </AlertDescription>
        </Alert>
      ) : null}

      {/* General load error */}
      {loadError ? (
        <Alert variant="destructive">
          <AlertTitle>Unable to load count tasks</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      ) : null}

      {/* Capture error */}
      {captureError ? (
        <Alert variant="destructive">
          <AlertTitle>Capture failed</AlertTitle>
          <AlertDescription>{captureError}</AlertDescription>
        </Alert>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Active task: capture mode                                           */}
      {/* ------------------------------------------------------------------ */}
      {activeTask ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="space-y-0.5">
              <p className="text-sm font-medium text-muted-foreground">Active task</p>
              <p className="font-semibold">{activeTask.task_name}</p>
              {activeTask.location_name ? (
                <p className="text-sm text-muted-foreground">{activeTask.location_name}</p>
              ) : null}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setActiveTask(null);
                setCaptureError(null);
                setForm(INITIAL_FORM);
              }}
            >
              Change task
            </Button>
          </div>

          {/* Capture form */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Capture item</CardTitle>
              <CardDescription>Scan the barcode, use RFID, or enter the item identifier manually.</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={(e) => void handleCapture(e)} className="space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="scan-method">Method</Label>
                  <Select
                    value={form.scanMethod}
                    onValueChange={(v) => setForm((f) => ({ ...f, scanMethod: v as ScanMethod }))}
                  >
                    <SelectTrigger id="scan-method">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="barcode">Barcode scan</SelectItem>
                      <SelectItem value="rfid">RFID scan</SelectItem>
                      <SelectItem value="manual">Manual entry</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {form.scanMethod === 'rfid' ? (
                  <Alert variant="destructive">
                    <AlertTitle>RFID unavailable in browser</AlertTitle>
                    <AlertDescription>
                      RFID capture requires the native mobile app. Switch to barcode or manual entry
                      to continue capturing in this browser session.
                    </AlertDescription>
                  </Alert>
                ) : (
                  <div className="space-y-1.5">
                    <Label htmlFor="scan-value">
                      {form.scanMethod === 'barcode' ? 'Barcode / scan value' : 'Item identifier'}
                    </Label>
                    <Input
                      id="scan-value"
                      ref={scanInputRef}
                      placeholder={
                        form.scanMethod === 'barcode'
                          ? 'Scan barcode or paste value'
                          : 'Enter item number or identifier'
                      }
                      value={form.scanValue}
                      onChange={(e) => setForm((f) => ({ ...f, scanValue: e.target.value }))}
                      autoComplete="off"
                      autoFocus
                    />
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="quantity">Quantity</Label>
                  <Input
                    id="quantity"
                    type="number"
                    min="1"
                    placeholder="1"
                    value={form.quantity}
                    onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="item-description">Description (optional)</Label>
                  <Input
                    id="item-description"
                    placeholder="Item name or notes"
                    value={form.itemDescription}
                    onChange={(e) => setForm((f) => ({ ...f, itemDescription: e.target.value }))}
                  />
                </div>

                <Button
                  type="submit"
                  className="w-full"
                  disabled={isCapturing || isStarting || form.scanMethod === 'rfid'}
                >
                  {isCapturing ? 'Capturing…' : isOnline ? 'Capture item' : 'Stage offline'}
                </Button>
              </form>
            </CardContent>
          </Card>

          {/* Offline queue summary */}
          {(pendingCount > 0 || failedCount > 0) && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Offline queue</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {pendingCount > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">{pendingCount} pending</span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void replayOfflineQueue()}
                      disabled={isReplaying || !isOnline}
                    >
                      {isReplaying ? 'Syncing…' : 'Sync now'}
                    </Button>
                  </div>
                )}
                {failedCount > 0 && (
                  <p className="text-sm text-destructive">
                    {failedCount} item(s) failed to sync.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Captured lines */}
          {lines.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Captured items ({lines.length})</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {lines.map((line) => (
                  <div
                    key={line.line_id}
                    className="flex items-start justify-between gap-2 border-b pb-2 last:border-0 last:pb-0"
                  >
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{line.scan_value}</p>
                      {line.item_description ? (
                        <p className="text-xs text-muted-foreground truncate">{line.item_description}</p>
                      ) : null}
                      <p className="text-xs text-muted-foreground">
                        {line.scan_method} · {formatTimestamp(line.captured_at)}
                      </p>
                    </div>
                    <Badge variant="outline" className="shrink-0">
                      ×{line.quantity}
                    </Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      ) : (
        /* ------------------------------------------------------------------ */
        /* Task list                                                           */
        /* ------------------------------------------------------------------ */
        <div className="space-y-4">
          {tasks.length === 0 && !loadError ? (
            <Card>
              <CardContent className="pt-6">
                <p className="text-center text-sm text-muted-foreground">
                  No count tasks are currently assigned to you. Contact your branch manager to be
                  assigned a task.
                </p>
              </CardContent>
            </Card>
          ) : null}

          {tasks.map((task) => (
            <Card key={task.count_task_id}>
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-0.5 min-w-0">
                    <CardTitle className="text-base leading-tight truncate">{task.task_name}</CardTitle>
                    {task.branch_name ? (
                      <CardDescription>{task.branch_name}</CardDescription>
                    ) : null}
                  </div>
                  <Badge variant={statusVariant(task.status)} className="shrink-0">
                    {task.status.replace('_', ' ')}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-3 pb-4">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                  {task.location_name ? <span>Location: {task.location_name}</span> : null}
                  {task.due_date ? <span>Due: {formatDate(task.due_date)}</span> : null}
                  {task.count_type ? <span>Type: {task.count_type.replace('_', ' ')}</span> : null}
                </div>
                {task.description ? (
                  <p className="text-sm text-muted-foreground line-clamp-2">{task.description}</p>
                ) : null}
                <Button
                  size="sm"
                  onClick={() => void startTask(task)}
                  disabled={isStarting}
                >
                  {task.status === 'planned' ? 'Start counting' : 'Continue counting'}
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
