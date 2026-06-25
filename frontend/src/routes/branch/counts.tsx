import { useCallback, useEffect, useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/auth/AuthContext';
import { canWrite } from '@/auth/types';
import { supabase } from '@/data/supabase';

type CountTaskStatus = 'planned' | 'in_progress' | 'submitted' | 'approved' | 'closed';
type CountScheduleType = 'ad_hoc' | 'recurring';
type CountType = 'full_branch' | 'cycle_count' | 'spot_check' | 'location_recount';
type VarianceReviewDecision = 'approve' | 'reject' | 'recount';

interface BranchOption {
  id: string;
  name: string;
}

interface CountTask {
  count_task_id: string;
  task_name: string;
  description: string | null;
  status: CountTaskStatus;
  branch_id: string | null;
  branch_name: string | null;
  location_name: string | null;
  assignee_name: string | null;
  due_date: string | null;
  count_type: CountType | null;
  schedule_type: CountScheduleType;
  recurrence_pattern: string | null;
  updated_by: string | null;
  updated_at: string | null;
  is_overdue: boolean;
}

interface BranchProgressRow {
  branch_id: string | null;
  branch_name: string | null;
  total_tasks: number;
  planned_tasks: number;
  in_progress_tasks: number;
  submitted_tasks: number;
  approved_tasks: number;
  closed_tasks: number;
  completed_tasks: number;
  overdue_tasks: number;
  completion_pct: number | null;
}

interface AuditEvent {
  audit_event_id: string;
  count_task_id: string;
  observed_at: string;
  event_type: string | null;
  previous_status: string | null;
  status: string | null;
  note: string | null;
  actor_name: string | null;
  actor_id: string | null;
  version_number: number | null;
}

interface CountTaskFormState {
  name: string;
  branchId: string;
  locationName: string;
  assigneeName: string;
  dueDate: string;
  countType: CountType;
  scheduleType: CountScheduleType;
  recurrencePattern: string;
  description: string;
}

const INITIAL_FORM_STATE: CountTaskFormState = {
  name: '',
  branchId: '',
  locationName: '',
  assigneeName: '',
  dueDate: '',
  countType: 'cycle_count',
  scheduleType: 'ad_hoc',
  recurrencePattern: '',
  description: '',
};

const COUNT_TYPE_LABELS: Record<CountType, string> = {
  full_branch: 'Full branch count',
  cycle_count: 'Cycle count',
  spot_check: 'Spot check',
  location_recount: 'Location recount',
};

const STATUS_LABELS: Record<CountTaskStatus, string> = {
  planned: 'Planned',
  in_progress: 'In Progress',
  submitted: 'Submitted',
  approved: 'Approved',
  closed: 'Closed',
};

const SCHEDULE_LABELS: Record<CountScheduleType, string> = {
  ad_hoc: 'Ad hoc',
  recurring: 'Recurring',
};

export const Route = createFileRoute('/branch/counts')({
  component: BranchCountSchedulingPage,
});

function normalizeNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return 'No due date';
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString();
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return 'Unknown time';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatCountType(value: CountType | null): string {
  return value ? COUNT_TYPE_LABELS[value] : 'Count';
}

function statusVariant(status: CountTaskStatus): 'secondary' | 'outline' | 'destructive' {
  if (status === 'approved') return 'secondary';
  if (status === 'closed') return 'outline';
  if (status === 'submitted') return 'secondary';
  return 'outline';
}

function getTransitionTargets(status: CountTaskStatus): CountTaskStatus[] {
  switch (status) {
    case 'planned':
      return ['in_progress', 'submitted', 'closed'];
    case 'in_progress':
      return ['planned', 'submitted', 'closed'];
    case 'submitted':
      return ['in_progress', 'approved', 'closed'];
    default:
      return [];
  }
}

async function fetchBranchOptions(): Promise<BranchOption[]> {
  const { data, error } = await supabase
    .from('rental_current_branches')
    .select('entity_id, name')
    .order('name', { ascending: true });

  if (error) throw error;

  return ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.entity_id || ''),
    name: String(row.name || 'Unnamed branch'),
  })).filter((row) => row.id);
}

async function fetchCountTasks(): Promise<CountTask[]> {
  const { data, error } = await supabase
    .from('rapidcount_count_tasks_current')
    .select('*')
    .order('due_date', { ascending: true });

  if (error) throw error;

  return ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    count_task_id: String(row.count_task_id || ''),
    task_name: String(row.task_name || 'Untitled Count Task'),
    description: typeof row.description === 'string' ? row.description : null,
    status: (row.status as CountTaskStatus) || 'planned',
    branch_id: typeof row.branch_id === 'string' ? row.branch_id : null,
    branch_name: typeof row.branch_name === 'string' ? row.branch_name : null,
    location_name: typeof row.location_name === 'string' ? row.location_name : null,
    assignee_name: typeof row.assignee_name === 'string' ? row.assignee_name : null,
    due_date: typeof row.due_date === 'string' ? row.due_date : null,
    count_type: (row.count_type as CountType | null) ?? null,
    schedule_type: (row.schedule_type as CountScheduleType) || 'ad_hoc',
    recurrence_pattern: typeof row.recurrence_pattern === 'string' ? row.recurrence_pattern : null,
    updated_by: typeof row.updated_by === 'string' ? row.updated_by : null,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : null,
    is_overdue: Boolean(row.is_overdue),
  })).filter((row) => row.count_task_id);
}

async function fetchBranchProgress(): Promise<BranchProgressRow[]> {
  const { data, error } = await supabase
    .from('rapidcount_count_branch_progress')
    .select('*')
    .order('branch_name', { ascending: true });

  if (error) throw error;

  return ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    branch_id: typeof row.branch_id === 'string' ? row.branch_id : null,
    branch_name: typeof row.branch_name === 'string' ? row.branch_name : null,
    total_tasks: normalizeNumber(row.total_tasks),
    planned_tasks: normalizeNumber(row.planned_tasks),
    in_progress_tasks: normalizeNumber(row.in_progress_tasks),
    submitted_tasks: normalizeNumber(row.submitted_tasks),
    approved_tasks: normalizeNumber(row.approved_tasks),
    closed_tasks: normalizeNumber(row.closed_tasks),
    completed_tasks: normalizeNumber(row.completed_tasks),
    overdue_tasks: normalizeNumber(row.overdue_tasks),
    completion_pct: row.completion_pct === null || row.completion_pct === undefined
      ? null
      : normalizeNumber(row.completion_pct),
  }));
}

async function fetchAuditHistory(countTaskId: string): Promise<AuditEvent[]> {
  const { data, error } = await supabase
    .from('rapidcount_count_task_audit_history')
    .select('*')
    .eq('count_task_id', countTaskId)
    .order('observed_at', { ascending: false });

  if (error) throw error;

  return ((data || []) as Array<Record<string, unknown>>).map((row) => ({
    audit_event_id: String(row.audit_event_id || ''),
    count_task_id: String(row.count_task_id || ''),
    observed_at: String(row.observed_at || ''),
    event_type: typeof row.event_type === 'string' ? row.event_type : null,
    previous_status: typeof row.previous_status === 'string' ? row.previous_status : null,
    status: typeof row.status === 'string' ? row.status : null,
    note: typeof row.note === 'string' ? row.note : null,
    actor_name: typeof row.actor_name === 'string' ? row.actor_name : null,
    actor_id: typeof row.actor_id === 'string' ? row.actor_id : null,
    version_number: row.version_number === null || row.version_number === undefined
      ? null
      : normalizeNumber(row.version_number),
  })).filter((row) => row.audit_event_id);
}

async function createCountTask(formState: CountTaskFormState) {
  const { data, error } = await supabase.rpc('rapidcount_create_count_task', {
    p_name: formState.name.trim(),
    p_branch_id: formState.branchId,
    p_assignee_name: formState.assigneeName.trim(),
    p_due_date: formState.dueDate,
    p_count_type: formState.countType,
    p_location_name: formState.locationName.trim() || null,
    p_schedule_type: formState.scheduleType,
    p_recurrence_pattern: formState.scheduleType === 'recurring'
      ? formState.recurrencePattern.trim() || null
      : null,
    p_description: formState.description.trim() || null,
  });

  if (error) throw error;

  const firstRow = Array.isArray(data) ? data[0] : null;
  return typeof firstRow?.count_task_id === 'string' ? firstRow.count_task_id : null;
}

async function transitionCountTask(countTaskId: string, status: CountTaskStatus) {
  const { error } = await supabase.rpc('rapidcount_transition_count_task', {
    p_count_task_id: countTaskId,
    p_status: status,
    p_note: null,
  });

  if (error) throw error;
}

async function reviewCountTaskVariances(
  countTaskId: string,
  decision: VarianceReviewDecision,
  reason: string
) {
  const { error } = await supabase.rpc('rapidcount_review_count_variances', {
    p_count_task_id: countTaskId,
    p_decision: decision,
    p_reason: reason,
  });

  if (error) throw error;
}

function BranchCountSchedulingPage() {
  return <BranchCountSchedulingScreen />;
}

export function BranchCountSchedulingScreen() {
  const { profile } = useAuth();
  const [branches, setBranches] = useState<BranchOption[]>([]);
  const [tasks, setTasks] = useState<CountTask[]>([]);
  const [progressRows, setProgressRows] = useState<BranchProgressRow[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [formState, setFormState] = useState<CountTaskFormState>(INITIAL_FORM_STATE);
  const [loading, setLoading] = useState(true);
  const [auditLoading, setAuditLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [transitioningTaskId, setTransitioningTaskId] = useState<string | null>(null);
  const [reviewReasons, setReviewReasons] = useState<Record<string, string>>({});

  const canManageCounts = canWrite(profile?.role);

  const selectedTask = useMemo(
    () => tasks.find((task) => task.count_task_id === selectedTaskId) ?? null,
    [tasks, selectedTaskId]
  );

  const loadDashboardData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [branchRows, countTaskRows, branchProgressRows] = await Promise.all([
        fetchBranchOptions(),
        fetchCountTasks(),
        fetchBranchProgress(),
      ]);
      setBranches(branchRows);
      setTasks(countTaskRows);
      setProgressRows(branchProgressRows);
      setSelectedTaskId((current) => {
        if (current && countTaskRows.some((task) => task.count_task_id === current)) {
          return current;
        }
        return countTaskRows[0]?.count_task_id ?? null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load RapidCount scheduling data.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAuditData = useCallback(async (countTaskId: string | null) => {
    if (!countTaskId) {
      setAuditEvents([]);
      return;
    }

    setAuditLoading(true);
    try {
      const events = await fetchAuditHistory(countTaskId);
      setAuditEvents(events);
    } catch (loadError) {
      setSubmitError(loadError instanceof Error ? loadError.message : 'Unable to load audit history.');
    } finally {
      setAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData]);

  useEffect(() => {
    void loadAuditData(selectedTaskId);
  }, [loadAuditData, selectedTaskId]);

  const updateFormState = <K extends keyof CountTaskFormState>(key: K, value: CountTaskFormState[K]) => {
    setFormState((current) => ({ ...current, [key]: value }));
  };

  const resetForm = () => {
    setFormState(INITIAL_FORM_STATE);
  };

  const handleCreateTask = async () => {
    setSubmitError(null);

    if (!formState.name.trim() || !formState.branchId || !formState.assigneeName.trim() || !formState.dueDate) {
      setSubmitError('Name, branch, assignee, and due date are required.');
      return;
    }

    if (formState.scheduleType === 'recurring' && !formState.recurrencePattern.trim()) {
      setSubmitError('Recurring tasks require a recurrence pattern.');
      return;
    }

    setIsSubmitting(true);
    try {
      const createdTaskId = await createCountTask(formState);
      resetForm();
      await loadDashboardData();
      if (createdTaskId) {
        setSelectedTaskId(createdTaskId);
      }
    } catch (createError) {
      setSubmitError(createError instanceof Error ? createError.message : 'Unable to create count task.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleTransition = async (countTaskId: string, status: CountTaskStatus) => {
    setSubmitError(null);
    setTransitioningTaskId(countTaskId);
    try {
      await transitionCountTask(countTaskId, status);
      await loadDashboardData();
      setSelectedTaskId(countTaskId);
      await loadAuditData(countTaskId);
    } catch (transitionError) {
      setSubmitError(transitionError instanceof Error ? transitionError.message : 'Unable to update count task status.');
    } finally {
      setTransitioningTaskId(null);
    }
  };

  const handleVarianceReview = async (
    countTaskId: string,
    decision: VarianceReviewDecision
  ) => {
    setSubmitError(null);

    const reason = reviewReasons[countTaskId]?.trim() || '';
    if (!reason) {
      setSubmitError('A review reason is required to approve, reject, or request a re-count.');
      return;
    }

    setTransitioningTaskId(countTaskId);
    try {
      await reviewCountTaskVariances(countTaskId, decision, reason);
      setReviewReasons((current) => {
        const next = { ...current };
        delete next[countTaskId];
        return next;
      });
      await loadDashboardData();
      setSelectedTaskId(countTaskId);
      await loadAuditData(countTaskId);
    } catch (reviewError) {
      setSubmitError(reviewError instanceof Error ? reviewError.message : 'Unable to complete variance review.');
    } finally {
      setTransitioningTaskId(null);
    }
  };

  if (!profile) {
    return (
      <Alert>
        <AlertTitle>Sign in required</AlertTitle>
        <AlertDescription>Sign in to manage RapidCount scheduling.</AlertDescription>
      </Alert>
    );
  }

  if (!canManageCounts) {
    return (
      <Alert variant="destructive">
        <AlertTitle>RapidCount scheduling is limited to managers</AlertTitle>
        <AlertDescription>Only admins and branch managers can schedule and reassign count tasks.</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-3xl font-semibold tracking-tight">RapidCount Scheduling</h1>
        <p className="text-sm text-muted-foreground">
          Schedule branch-level count work, track ownership, and audit task-state handoffs from plan through approval.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Unable to load RapidCount scheduling</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {submitError ? (
        <Alert variant="destructive">
          <AlertTitle>RapidCount action failed</AlertTitle>
          <AlertDescription>{submitError}</AlertDescription>
        </Alert>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Create Count Task</CardTitle>
          <CardDescription>
            Create ad hoc or recurring work scoped to a branch/location with an owner, due date, and count type.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="count-task-name">Task name</Label>
              <Input
                id="count-task-name"
                value={formState.name}
                onChange={(event) => updateFormState('name', event.target.value)}
                placeholder="North Yard weekly cycle count"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="count-task-branch">Branch</Label>
              <Select value={formState.branchId} onValueChange={(value) => updateFormState('branchId', value)}>
                <SelectTrigger id="count-task-branch">
                  <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent>
                  {branches.map((branch) => (
                    <SelectItem key={branch.id} value={branch.id}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="count-task-location">Location</Label>
              <Input
                id="count-task-location"
                value={formState.locationName}
                onChange={(event) => updateFormState('locationName', event.target.value)}
                placeholder="Aisles A-C"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="count-task-assignee">Assignee</Label>
              <Input
                id="count-task-assignee"
                value={formState.assigneeName}
                onChange={(event) => updateFormState('assigneeName', event.target.value)}
                placeholder="Casey Counter"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="count-task-due-date">Due date</Label>
              <Input
                id="count-task-due-date"
                type="date"
                value={formState.dueDate}
                onChange={(event) => updateFormState('dueDate', event.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="count-task-count-type">Count type</Label>
              <Select value={formState.countType} onValueChange={(value) => updateFormState('countType', value as CountType)}>
                <SelectTrigger id="count-task-count-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(COUNT_TYPE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="count-task-schedule-type">Schedule type</Label>
              <Select value={formState.scheduleType} onValueChange={(value) => updateFormState('scheduleType', value as CountScheduleType)}>
                <SelectTrigger id="count-task-schedule-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(SCHEDULE_LABELS).map(([value, label]) => (
                    <SelectItem key={value} value={value}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {formState.scheduleType === 'recurring' ? (
              <div className="space-y-1">
                <Label htmlFor="count-task-recurrence">Recurrence pattern</Label>
                <Input
                  id="count-task-recurrence"
                  value={formState.recurrencePattern}
                  onChange={(event) => updateFormState('recurrencePattern', event.target.value)}
                  placeholder="weekly:mon"
                />
              </div>
            ) : null}
          </div>

          <div className="space-y-1">
            <Label htmlFor="count-task-description">Description</Label>
            <Textarea
              id="count-task-description"
              value={formState.description}
              onChange={(event) => updateFormState('description', event.target.value)}
              placeholder="Outline the count scope, prep notes, or reconciliation context."
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={() => void handleCreateTask()} disabled={isSubmitting || loading}>
              {isSubmitting ? 'Creating…' : 'Create count task'}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[1.35fr_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>Branch Progress</CardTitle>
            <CardDescription>
              Managers can see open workload, overdue tasks, and completion progress without a separate inventory master.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading branch progress…</p>
            ) : progressRows.length === 0 ? (
              <p className="text-sm text-muted-foreground">No RapidCount tasks have been scheduled yet.</p>
            ) : (
              progressRows.map((row) => (
                <div key={row.branch_id || row.branch_name || 'unassigned'} className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-medium">{row.branch_name || 'Unassigned branch'}</p>
                      <p className="text-sm text-muted-foreground">
                        {row.completed_tasks}/{row.total_tasks} complete • {row.overdue_tasks} overdue
                      </p>
                    </div>
                    <Badge variant={row.overdue_tasks > 0 ? 'destructive' : 'secondary'}>
                      {row.completion_pct ?? 0}% complete
                    </Badge>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Planned {row.planned_tasks} • In progress {row.in_progress_tasks} • Submitted {row.submitted_tasks} • Approved {row.approved_tasks} • Closed {row.closed_tasks}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card data-testid="audit-history-card">
          <CardHeader>
            <CardTitle>Audit History</CardTitle>
            <CardDescription>
              {selectedTask ? `Latest handoffs for ${selectedTask.task_name}.` : 'Select a count task to review its audit trail.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {auditLoading ? (
              <p className="text-sm text-muted-foreground">Loading audit history…</p>
            ) : auditEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground">No audit events recorded yet.</p>
            ) : (
              auditEvents.map((event) => (
                <div key={event.audit_event_id} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {event.previous_status ? `${event.previous_status} → ${event.status}` : event.status || event.event_type || 'Event'}
                    </p>
                    <Badge variant="outline">v{event.version_number ?? '—'}</Badge>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {event.actor_name || 'System'} • {formatTimestamp(event.observed_at)}
                  </p>
                  {event.note ? (
                    <p className="mt-1 text-sm">{event.note}</p>
                  ) : null}
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Scheduled Count Tasks</CardTitle>
          <CardDescription>
            Track assignment ownership, due dates, count types, and state transitions from planning through approval.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading count tasks…</p>
          ) : tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No RapidCount tasks are scheduled yet.</p>
          ) : (
            tasks.map((task) => (
              <div key={task.count_task_id} data-testid="count-task-row" className="rounded-lg border p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{task.task_name}</p>
                      <Badge variant={statusVariant(task.status)}>{STATUS_LABELS[task.status]}</Badge>
                      {task.is_overdue ? <Badge variant="destructive">Overdue</Badge> : null}
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {task.branch_name || 'Unassigned branch'}
                      {task.location_name ? ` • ${task.location_name}` : ''}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      Owner {task.assignee_name || 'Unassigned'} • Due {formatDate(task.due_date)} • {formatCountType(task.count_type)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {SCHEDULE_LABELS[task.schedule_type]}
                      {task.recurrence_pattern ? ` • ${task.recurrence_pattern}` : ''}
                      {task.updated_by ? ` • Last updated by ${task.updated_by}` : ''}
                    </p>
                    {task.description ? <p className="text-sm">{task.description}</p> : null}
                    {task.status === 'submitted' ? (
                      <div className="space-y-1 pt-1">
                        <Label htmlFor={`variance-review-reason-${task.count_task_id}`}>Variance review reason</Label>
                        <Input
                          id={`variance-review-reason-${task.count_task_id}`}
                          value={reviewReasons[task.count_task_id] ?? ''}
                          onChange={(event) => setReviewReasons((current) => ({
                            ...current,
                            [task.count_task_id]: event.target.value,
                          }))}
                          placeholder="Explain why this variance is approved, rejected, or re-counted."
                        />
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap justify-end gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setSelectedTaskId(task.count_task_id)}
                    >
                      View Audit
                    </Button>
                    {task.status === 'submitted' ? (
                      <>
                        <Button
                          variant="outline"
                          disabled={transitioningTaskId === task.count_task_id}
                          onClick={() => void handleVarianceReview(task.count_task_id, 'recount')}
                        >
                          {transitioningTaskId === task.count_task_id ? 'Saving…' : 'Request Re-count'}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={transitioningTaskId === task.count_task_id}
                          onClick={() => void handleVarianceReview(task.count_task_id, 'reject')}
                        >
                          {transitioningTaskId === task.count_task_id ? 'Saving…' : 'Reject Variance'}
                        </Button>
                        <Button
                          disabled={transitioningTaskId === task.count_task_id}
                          onClick={() => void handleVarianceReview(task.count_task_id, 'approve')}
                        >
                          {transitioningTaskId === task.count_task_id ? 'Saving…' : 'Approve Variance'}
                        </Button>
                      </>
                    ) : (
                      getTransitionTargets(task.status).map((targetStatus) => (
                        <Button
                          key={targetStatus}
                          variant={targetStatus === 'approved' ? 'default' : 'outline'}
                          disabled={transitioningTaskId === task.count_task_id}
                          onClick={() => void handleTransition(task.count_task_id, targetStatus)}
                        >
                          {transitioningTaskId === task.count_task_id
                            ? 'Saving…'
                            : targetStatus === 'in_progress'
                              ? 'Start Count'
                              : targetStatus === 'submitted'
                                ? 'Submit Count'
                                : targetStatus === 'approved'
                                  ? 'Approve Count'
                                  : targetStatus === 'planned'
                                    ? 'Replan'
                                    : 'Close Task'}
                        </Button>
                      ))
                    )}
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
