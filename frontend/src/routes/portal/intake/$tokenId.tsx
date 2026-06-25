/**
 * Customer Portal – Self-Serve Intake Form
 *
 * Standalone, no-chrome route accessible via a shareable email/SMS link.
 * URL: /portal/intake/:tokenId#token=<raw_token>
 *
 * The raw bearer token is delivered in the URL fragment (hash) so it is
 * never included in the HTTP request line, server access logs, Referer
 * headers, or proxy logs — the browser never sends the fragment to the
 * server.  The token is extracted from the fragment on mount, scrubbed from
 * the address bar via history.replaceState, retained only in component
 * memory, and sent directly to the portal_submit_intake RPC (SECURITY
 * DEFINER).
 *
 * External callers may only submit the explicit fields defined here; no
 * arbitrary JSON merge path is exposed on the public surface.
 *
 * Document upload staging is available through portal_stage_document_metadata.
 * Actual blob content and document retrieval are authenticated back-office paths.
 */

import { useCallback, useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { CheckCircle2, AlertCircle, Loader2, ClipboardList } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/data/supabase';

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/portal/intake/$tokenId')({
  component: PortalIntakePage,
});

function PortalIntakePage() {
  const { tokenId } = Route.useParams();
  const pageUrl =
    typeof window !== 'undefined' ? window.location.href : '';
  return <PortalIntakeScreen tokenId={tokenId} pageUrl={pageUrl} />;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface IntakeFormFields {
  customerName: string;
  customerType: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
  jobSiteName: string;
  jobSiteAddress: string;
}

export interface PortalIntakeScreenProps {
  tokenId: string;
  /** Override the page URL for testing (defaults to window.location.href). */
  pageUrl?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function extractIntakeToken(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    const token = hashParams.get('token');
    return token && token.trim().length > 0 ? token.trim() : null;
  } catch {
    return null;
  }
}

function isIntakeTokenDenied(message: string | null): boolean {
  if (!message) {
    return false;
  }

  return /intake token (?:is required|is invalid|has been revoked|has expired)/i.test(message);
}

const EMPTY_FORM: IntakeFormFields = {
  customerName: '',
  customerType: '',
  contactName: '',
  contactEmail: '',
  contactPhone: '',
  jobSiteName: '',
  jobSiteAddress: '',
};

// ---------------------------------------------------------------------------
// Main screen (exported for testing)
// ---------------------------------------------------------------------------

export function PortalIntakeScreen({ pageUrl }: PortalIntakeScreenProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [form, setForm] = useState<IntakeFormFields>(EMPTY_FORM);
  const [intakeToken] = useState(() =>
    extractIntakeToken(pageUrl ?? (typeof window !== 'undefined' ? window.location.href : '')),
  );
  const [tokenDenied, setTokenDenied] = useState(() => intakeToken === null);

  // Scrub the raw bearer token from the address bar once it has been captured
  // in memory.  Because the token is delivered in the URL fragment it never
  // reaches the server, but clearing the fragment still prevents it from
  // appearing in subsequent browser-history entries, copied URLs, or
  // screenshots.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash.includes('token=')) {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      );
    }
  }, []); // intentionally runs once on mount

  // If no token is present in the URL the form is not usable.
  const tokenMissing = intakeToken === null;

  // Reset error when the form changes
  useEffect(() => {
    if (submitError) setSubmitError(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form]);

  const handleChange = useCallback(
    (field: keyof IntakeFormFields) =>
      (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
        setForm((prev) => ({ ...prev, [field]: e.target.value }));
      },
    [],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!intakeToken) {
        setSubmitError('No intake token found in the URL. Please use the link from your email or SMS.');
        setTokenDenied(true);
        return;
      }

      setIsSubmitting(true);
      setSubmitError(null);

      const { error } = await supabase.rpc('portal_submit_intake', {
        p_token:            intakeToken,
        p_customer_name:    form.customerName.trim() || null,
        p_customer_type:    form.customerType.trim() || null,
        p_contact_name:     form.contactName.trim() || null,
        p_contact_email:    form.contactEmail.trim() || null,
        p_contact_phone:    form.contactPhone.trim() || null,
        p_job_site_name:    form.jobSiteName.trim() || null,
        p_job_site_address: form.jobSiteAddress.trim() || null,
      });

      setIsSubmitting(false);

      if (error) {
        const message =
          (error as { message?: string }).message ?? 'Submission failed. Please try again.';
        setSubmitError(message);
        setTokenDenied(isIntakeTokenDenied(message));
        return;
      }

      setTokenDenied(false);
      setSubmitted(true);
    },
    [intakeToken, form],
  );

  if (submitted) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4" data-testid="portal-intake-page">
        <Card className="w-full max-w-lg">
          <CardContent className="pt-8 pb-8 flex flex-col items-center gap-4 text-center">
            <CheckCircle2 className="h-12 w-12 text-green-600" aria-hidden="true" />
            <h1 className="text-xl font-semibold" data-testid="intake-success-heading">
              Information received
            </h1>
            <p className="text-sm text-muted-foreground">
              Thank you. Your details have been submitted. Our team will be in touch shortly.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4" data-testid="portal-intake-page">
      <Card className="w-full max-w-lg">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-3">
            <ClipboardList className="h-6 w-6 text-blue-600" aria-hidden="true" />
            <div>
              <CardTitle className="text-lg leading-tight" data-testid="intake-form-title">
                Customer Intake
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-0.5">
                Please fill in your details below.
              </p>
            </div>
          </div>
          <Badge className="self-start mt-2 bg-blue-100 text-blue-800 hover:bg-blue-100">
            Secure intake form
          </Badge>
        </CardHeader>

        <CardContent>
          {tokenMissing && (
            <Alert variant="destructive" className="mb-4" data-testid="token-missing-error">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Invalid link</AlertTitle>
              <AlertDescription>
                This intake link is missing a secure token. Please use the original link from your email or SMS message.
              </AlertDescription>
            </Alert>
          )}

          {submitError && (
            <Alert variant="destructive" className="mb-4" data-testid="submit-error">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>{tokenDenied ? 'Invalid or expired link' : 'Submission failed'}</AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}

          <form onSubmit={(e) => void handleSubmit(e)} noValidate data-testid="intake-form">
            <fieldset disabled={tokenMissing || tokenDenied || isSubmitting}>
              {/* Company information */}
              <section aria-labelledby="company-section-label" className="mb-5">
                <h2 id="company-section-label" className="text-sm font-medium text-gray-700 mb-3">
                  Company information
                </h2>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="intake-customer-name">Company name</Label>
                    <Input
                      id="intake-customer-name"
                      data-testid="input-customer-name"
                      placeholder="Acme Equipment Rentals"
                      value={form.customerName}
                      onChange={handleChange('customerName')}
                      autoComplete="organization"
                    />
                  </div>
                  <div>
                    <Label htmlFor="intake-customer-type">Customer type</Label>
                    <Input
                      id="intake-customer-type"
                      data-testid="input-customer-type"
                      placeholder="e.g. commercial, government, individual"
                      value={form.customerType}
                      onChange={handleChange('customerType')}
                    />
                  </div>
                </div>
              </section>

              {/* Primary contact */}
              <section aria-labelledby="contact-section-label" className="mb-5">
                <h2 id="contact-section-label" className="text-sm font-medium text-gray-700 mb-3">
                  Primary contact
                </h2>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="intake-contact-name">Full name</Label>
                    <Input
                      id="intake-contact-name"
                      data-testid="input-contact-name"
                      placeholder="Jane Smith"
                      value={form.contactName}
                      onChange={handleChange('contactName')}
                      autoComplete="name"
                    />
                  </div>
                  <div>
                    <Label htmlFor="intake-contact-email">Email address</Label>
                    <Input
                      id="intake-contact-email"
                      data-testid="input-contact-email"
                      type="email"
                      placeholder="jane@example.com"
                      value={form.contactEmail}
                      onChange={handleChange('contactEmail')}
                      autoComplete="email"
                    />
                  </div>
                  <div>
                    <Label htmlFor="intake-contact-phone">Phone number</Label>
                    <Input
                      id="intake-contact-phone"
                      data-testid="input-contact-phone"
                      type="tel"
                      placeholder="555-000-1234"
                      value={form.contactPhone}
                      onChange={handleChange('contactPhone')}
                      autoComplete="tel"
                    />
                  </div>
                </div>
              </section>

              {/* Job site */}
              <section aria-labelledby="jobsite-section-label" className="mb-6">
                <h2 id="jobsite-section-label" className="text-sm font-medium text-gray-700 mb-3">
                  Job site <span className="font-normal text-gray-500">(optional)</span>
                </h2>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="intake-job-site-name">Site name</Label>
                    <Input
                      id="intake-job-site-name"
                      data-testid="input-job-site-name"
                      placeholder="Downtown Construction Site"
                      value={form.jobSiteName}
                      onChange={handleChange('jobSiteName')}
                    />
                  </div>
                  <div>
                    <Label htmlFor="intake-job-site-address">Site address</Label>
                    <Input
                      id="intake-job-site-address"
                      data-testid="input-job-site-address"
                      placeholder="123 Main St, City, TX 75000"
                      value={form.jobSiteAddress}
                      onChange={handleChange('jobSiteAddress')}
                      autoComplete="street-address"
                    />
                  </div>
                </div>
              </section>

              <Button
                type="submit"
                className="w-full"
                disabled={tokenMissing || tokenDenied || isSubmitting}
                data-testid="submit-button"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
                    Submitting…
                  </>
                ) : (
                  'Submit'
                )}
              </Button>
            </fieldset>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
