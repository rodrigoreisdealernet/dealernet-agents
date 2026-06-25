import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import type { ConflictAssistantResult } from '@/lib/bookingConflictAssistant';

interface ConflictAssistantPanelProps {
  title: string;
  description: string;
  result: ConflictAssistantResult;
  allowFollowUpApproval?: boolean;
}

function priorityVariant(priority: ConflictAssistantResult['items'][number]['priority']): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (priority) {
    case 'blocking':
      return 'destructive';
    case 'review':
      return 'default';
    case 'warning':
      return 'secondary';
    default:
      return 'outline';
  }
}

function statusLabel(status: ConflictAssistantResult['items'][number]['status']): string {
  switch (status) {
    case 'conflict':
      return 'Conflict';
    case 'follow_up':
      return 'Follow-up';
    case 'uncertain':
      return 'Uncertain';
    default:
      return 'No-op';
  }
}

export function ConflictAssistantPanel({
  title,
  description,
  result,
  allowFollowUpApproval = false,
}: ConflictAssistantPanelProps) {
  const [approvedFollowUps, setApprovedFollowUps] = useState<Record<string, true>>({});

  return (
    <section className="mx-auto mt-6 max-w-7xl px-4 sm:px-6 lg:px-8" data-testid="booking-conflict-assistant">
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div className="space-y-1">
              <h2 className="text-2xl font-semibold leading-none tracking-tight">{title}</h2>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {result.tags.map((tag) => (
                <Badge key={tag} variant="outline">{tag}</Badge>
              ))}
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {result.noOp ? (
            <Alert>
              <AlertTitle>{result.items[0]?.title || 'No materially new branch conflict'}</AlertTitle>
              <AlertDescription>{result.items[0]?.summary}</AlertDescription>
            </Alert>
          ) : null}

          {!result.noOp ? result.items.map((item) => (
            <div key={item.id} className="space-y-3 rounded-lg border p-4">
              <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{item.title}</h3>
                    <Badge variant={priorityVariant(item.priority)}>{statusLabel(item.status)}</Badge>
                    <Badge variant="outline">{item.workflow.replace('_', ' ')}</Badge>
                    {item.requiresHumanApproval ? <Badge variant="outline">Human approval required</Badge> : null}
                  </div>
                  <p className="text-sm text-muted-foreground">{item.summary}</p>
                </div>
                <div className="flex flex-wrap gap-2 text-sm">
                  {item.orderId ? (
                    <Link className="text-primary underline-offset-4 hover:underline" to={`/rental/orders/${item.orderId}` as never}>
                      Order {item.orderId}
                    </Link>
                  ) : null}
                  {item.contractId ? (
                    <Link className="text-primary underline-offset-4 hover:underline" to={`/rental/contracts/${item.contractId}` as never}>
                      Contract {item.contractId}
                    </Link>
                  ) : null}
                  {item.lineId ? <span className="text-muted-foreground">Line {item.lineId}</span> : null}
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium">Evidence</p>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  {item.evidence.map((evidence, index) => (
                    <li key={`${item.id}-${evidence.source}-${evidence.label}-${index}`}>
                      <span className="font-medium text-foreground">{evidence.label}:</span>{' '}
                      {evidence.detail}
                    </li>
                  ))}
                </ul>
              </div>

              <Alert>
                <AlertTitle>Recommended next step</AlertTitle>
                <AlertDescription>{item.recommendation}</AlertDescription>
              </Alert>

              {allowFollowUpApproval ? (
                <div className="flex flex-col gap-2 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
                  <p className="text-xs text-muted-foreground">
                    Session-only approval confirms the chosen manual coordination path here without changing route status, customer promises, or spend controls.
                  </p>
                  <Button
                    variant={approvedFollowUps[item.id] ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={() => setApprovedFollowUps((prev) => ({ ...prev, [item.id]: true }))}
                    disabled={Boolean(approvedFollowUps[item.id])}
                  >
                    {approvedFollowUps[item.id] ? 'Follow-up path approved' : 'Approve manual follow-up'}
                  </Button>
                </div>
              ) : null}
            </div>
          )) : null}
        </CardContent>
      </Card>
    </section>
  );
}
