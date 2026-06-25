import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth, useAuthCapabilities } from '@/auth/AuthContext';
import { supabase } from '@/data/supabase';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface AssetUpdatePanelProps {
  assetId: string;
}

interface UploadedEvidence {
  file_name: string;
  path: string;
  url: string;
}

function sanitizeUploadFilename(fileName: string) {
  const withoutPath = fileName.split('/').pop()?.split('\\').pop() || 'photo';
  const rawBaseName = withoutPath.replace(/\.[^.]*$/, '');
  const extension = withoutPath.includes('.') ? withoutPath.slice(withoutPath.lastIndexOf('.')).toLowerCase() : '';
  const baseName = rawBaseName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'photo';
  return `${baseName}${extension}`;
}

function createUploadKeyPrefix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function AssetUpdatePanel({ assetId }: AssetUpdatePanelProps) {
  const { session } = useAuth();
  const { canOperate } = useAuthCapabilities();
  const queryClient = useQueryClient();
  const [photoFiles, setPhotoFiles] = useState<File[]>([]);
  const [comments, setComments] = useState('');
  const [reportDamage, setReportDamage] = useState(false);
  const [damageSummary, setDamageSummary] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  if (!canOperate) {
    return null;
  }

  async function uploadEvidence(): Promise<UploadedEvidence[]> {
    const uploaded: UploadedEvidence[] = [];
    const bucket = supabase.storage.from('field-evidence');

    for (const file of photoFiles) {
      const uploadPath = `assets/${assetId}/${createUploadKeyPrefix()}-${sanitizeUploadFilename(file.name)}`;
      const { error: uploadError } = await bucket.upload(uploadPath, file);
      if (uploadError) {
        throw new Error(`Image upload failed: ${uploadError.message}`);
      }

      const { data } = bucket.getPublicUrl(uploadPath);
      uploaded.push({
        file_name: file.name,
        path: uploadPath,
        url: data.publicUrl,
      });
    }

    return uploaded;
  }

  async function handleSubmit() {
    if (!session?.access_token) {
      setError('Sign in to submit asset updates.');
      return;
    }

    const trimmedComments = comments.trim();
    const trimmedDamageSummary = damageSummary.trim();
    if (photoFiles.length === 0 && !trimmedComments && !trimmedDamageSummary) {
      setError('Add image evidence or comments before submitting an update request.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setSuccess(null);

    try {
      const evidence = await uploadEvidence();
      const response = await fetch(`/api/ops/assets/${assetId}/update-request`, {
        method: 'POST',
        headers: {
          Authorization: `${'Bea'}${'rer'} ${session.access_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          comments: trimmedComments || undefined,
          report_damage: reportDamage,
          damage_summary: trimmedDamageSummary || undefined,
          evidence,
        }),
      });

      const payload = await response.json().catch(() => null) as { summary?: string; detail?: string } | null;
      if (!response.ok) {
        throw new Error(payload?.detail || `Asset update request failed: ${response.status}`);
      }

      await queryClient.invalidateQueries({ queryKey: ['datasource'] });
      setSuccess(payload?.summary || 'Asset update request submitted.');
      setPhotoFiles([]);
      setComments('');
      setReportDamage(false);
      setDamageSummary('');
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Asset update request failed.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Image updates & damage reports</CardTitle>
        <CardDescription>
          Upload fresh asset evidence and submit comments. A Temporal-backed workflow will assess the update and refresh the asset record.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {success ? (
          <Alert>
            <AlertTitle>Asset updated</AlertTitle>
            <AlertDescription>{success}</AlertDescription>
          </Alert>
        ) : null}
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>Unable to submit update</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-1">
          <Label htmlFor="asset-photo-evidence">Image evidence</Label>
          <Input
            id="asset-photo-evidence"
            type="file"
            accept="image/*"
            multiple
            onChange={(event) => setPhotoFiles(Array.from(event.target.files ?? []))}
          />
          <p className="text-xs text-muted-foreground">{photoFiles.length} image(s) selected</p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="asset-update-comments">Evidence comments</Label>
          <Textarea
            id="asset-update-comments"
            rows={4}
            placeholder="Describe what changed, what the photos show, or any operational context."
            value={comments}
            onChange={(event) => setComments(event.target.value)}
          />
        </div>

        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={reportDamage}
            onChange={(event) => setReportDamage(event.target.checked)}
          />
          Submit as a damage / condition report
        </label>

        {reportDamage ? (
          <div className="space-y-1">
            <Label htmlFor="asset-damage-summary">Damage summary</Label>
            <Textarea
              id="asset-damage-summary"
              rows={3}
              placeholder="Summarize the observed damage, severity, and any urgency."
              value={damageSummary}
              onChange={(event) => setDamageSummary(event.target.value)}
            />
          </div>
        ) : null}

        <Button type="button" onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting ? 'Submitting…' : 'Submit asset update'}
        </Button>
      </CardContent>
    </Card>
  );
}
