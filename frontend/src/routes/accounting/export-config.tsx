import { useEffect, useState } from 'react';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useAuth } from '@/auth/AuthContext';
import { canConfigureAccountingExport, type AppRole } from '@/auth/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { supabase } from '@/data/supabase';

type ExportMode = 'xero' | 'sage' | 'export_only';

interface ExportConfig {
  id: string;
  export_mode: ExportMode;
  format_version: string;
  account_code_map: Record<string, string>;
  tax_code_map: Record<string, string>;
  notes: string | null;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

interface ExportRun {
  id: string;
  export_mode: ExportMode;
  format_version: string;
  period_start: string;
  period_end: string;
  basis: string;
  triggered_by: string;
  row_count: number;
  artifact_status: 'pending' | 'complete' | 'empty' | 'failed';
  error_detail: string | null;
  created_at: string;
}

const EXPORT_MODE_LABELS: Record<ExportMode, string> = {
  xero: 'Xero (CSV import)',
  sage: 'Sage Intacct (GL journal CSV)',
  export_only: 'Export only (accountant hand-off CSV)',
};

const FORMAT_VERSION_FOR_MODE: Record<ExportMode, string> = {
  xero: 'xero_csv_v1',
  sage: 'sage_intacct_gl_csv_v1',
  export_only: 'export_only_v1',
};

function asAppRole(value: unknown): AppRole | undefined {
  const valid: AppRole[] = ['admin', 'branch_manager', 'field_operator', 'read_only'];
  return valid.includes(value as AppRole) ? (value as AppRole) : undefined;
}

export const Route = createFileRoute('/accounting/export-config')({
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getSession();
    if (error || !canConfigureAccountingExport(asAppRole(data.session?.user?.app_metadata?.role))) {
      throw redirect({ to: '/' });
    }
  },
  component: AccountingExportConfigPage,
});

export function AccountingExportConfigPage() {
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const configQuery = useQuery<ExportConfig | null>({
    queryKey: ['accounting-export-config'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('accounting_export_config')
        .select('*')
        .eq('enabled', true)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  });

  const runsQuery = useQuery<ExportRun[]>({
    queryKey: ['accounting-export-runs'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('accounting_export_runs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return data ?? [];
    },
  });

  const [selectedMode, setSelectedMode] = useState<ExportMode>('export_only');
  const [notes, setNotes] = useState('');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (configQuery.data) {
      setSelectedMode(configQuery.data.export_mode);
      setNotes(configQuery.data.notes ?? '');
    }
  }, [configQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) throw new Error('Not authenticated');

      const opsApiBase = import.meta.env.VITE_OPS_API_BASE ?? '';
      const resp = await fetch(`${opsApiBase}/api/ops/accounting/export/configure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
        },
        body: JSON.stringify({
          export_mode: selectedMode,
          notes: notes.trim() || null,
          account_code_map: {},
          tax_code_map: {},
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Save failed (${resp.status}): ${body}`);
      }
      return resp.json() as Promise<{ status: string; export_mode: string }>;
    },
    onSuccess: () => {
      setSaveMessage(`Export mode saved: ${EXPORT_MODE_LABELS[selectedMode]}`);
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey: ['accounting-export-config'] });
      void queryClient.invalidateQueries({ queryKey: ['accounting-export-runs'] });
    },
    onError: (err: Error) => {
      setSaveError(err.message);
      setSaveMessage(null);
    },
  });

  if (!canConfigureAccountingExport(profile?.role)) {
    return (
      <div className="p-6">
        <Alert variant="destructive">
          <AlertTitle>Access denied</AlertTitle>
          <AlertDescription>Admin role required to configure accounting export settings.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Accounting export configuration</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configure how posted ledger data is formatted for export. Operators can generate exports
          from the General Ledger screen once a mode is configured.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Current configuration</CardTitle>
          <CardDescription>
            Active export mode for this tenant. Changing the mode takes effect on the next export
            run.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {configQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Loading configuration…</p>
          )}
          {configQuery.data && (
            <div className="rounded-md border p-4 space-y-2 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Mode:</span>
                <Badge variant="secondary">{EXPORT_MODE_LABELS[configQuery.data.export_mode]}</Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-muted-foreground">Format version:</span>
                <span className="font-mono text-xs">{configQuery.data.format_version}</span>
              </div>
              {configQuery.data.notes && (
                <div>
                  <span className="text-muted-foreground">Notes: </span>
                  <span>{configQuery.data.notes}</span>
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                Configured by {configQuery.data.created_by ?? '—'} on{' '}
                {new Date(configQuery.data.created_at).toLocaleDateString()}
              </div>
            </div>
          )}
          {!configQuery.isLoading && !configQuery.data && (
            <p className="text-sm text-muted-foreground">No export mode configured yet.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Set export mode</CardTitle>
          <CardDescription>
            Select the target format. No live provider connection is required — exports work in
            standalone mode and produce a downloadable CSV for import into the target system.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="export-mode">Export mode</Label>
            <select
              id="export-mode"
              className="flex h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              value={selectedMode}
              onChange={(e) => setSelectedMode(e.target.value as ExportMode)}
            >
              <option value="xero">Xero — manual journal CSV (xero_csv_v1)</option>
              <option value="sage">Sage Intacct — GL journal CSV (sage_intacct_gl_csv_v1)</option>
              <option value="export_only">Export only — accountant hand-off CSV (export_only_v1)</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="export-notes">Notes (optional)</Label>
            <input
              id="export-notes"
              type="text"
              className="flex h-9 w-full max-w-sm rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              placeholder="e.g. Used by accountant Jane Smith"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
            />
          </div>
          <div className="text-xs text-muted-foreground">
            Format version that will be stored:{' '}
            <span className="font-mono">{FORMAT_VERSION_FOR_MODE[selectedMode]}</span>
          </div>
          <Button
            type="button"
            onClick={() => void saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            {saveMutation.isPending ? 'Saving…' : 'Save export mode'}
          </Button>
          {saveMessage && (
            <Alert>
              <AlertTitle>Saved</AlertTitle>
              <AlertDescription>{saveMessage}</AlertDescription>
            </Alert>
          )}
          {saveError && (
            <Alert variant="destructive">
              <AlertTitle>Save failed</AlertTitle>
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent export runs</CardTitle>
          <CardDescription>
            Audit log of export runs triggered by operators. The CSV payload is not stored — only
            run metadata (who, when, period, row count, status) is retained.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {runsQuery.isLoading && (
            <p className="text-sm text-muted-foreground">Loading export runs…</p>
          )}
          {!runsQuery.isLoading && (!runsQuery.data || runsQuery.data.length === 0) && (
            <p className="text-sm text-muted-foreground">No export runs yet.</p>
          )}
          {!runsQuery.isLoading && runsQuery.data && runsQuery.data.length > 0 && (
            <div className="space-y-2">
              {runsQuery.data.map((run) => (
                <div
                  key={run.id}
                  className="flex flex-wrap items-center gap-3 rounded-md border px-4 py-3 text-sm"
                >
                  <Badge
                    variant={
                      run.artifact_status === 'complete'
                        ? 'default'
                        : run.artifact_status === 'failed'
                          ? 'destructive'
                          : 'secondary'
                    }
                  >
                    {run.artifact_status}
                  </Badge>
                  <span className="font-medium">{EXPORT_MODE_LABELS[run.export_mode]}</span>
                  <span className="text-muted-foreground">
                    {run.period_start} – {run.period_end}
                  </span>
                  <span className="text-muted-foreground">{run.row_count} rows</span>
                  <span className="text-muted-foreground">by {run.triggered_by}</span>
                  <span className="text-xs text-muted-foreground">
                    {new Date(run.created_at).toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
