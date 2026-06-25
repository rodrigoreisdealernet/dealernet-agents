/**
 * Customer Portal – Billing & Payment Update Request Form
 *
 * Standalone, no-chrome route accessible via a shareable email/SMS link.
 * URL: /portal/billing-update/:tokenId#token=<raw_token>
 *
 * Security model mirrors /portal/intake/:tokenId:
 *   - The raw bearer token is delivered in the URL fragment (hash) so it is
 *     never included in the HTTP request line, server access logs, Referer
 *     headers, or proxy logs.
 *   - The token is extracted on mount, scrubbed from the address bar via
 *     history.replaceState, retained only in component memory, and sent to
 *     portal_submit_billing_update_request (SECURITY DEFINER).
 *   - Only the explicitly declared fields are transmitted; no arbitrary JSON
 *     merge path is exposed on the public surface.
 *
 * Operating-model tags: rental-customer-portal-user:t5 (initiation),
 *                       rental-customer-portal-user:t7 (status visibility).
 */

import { useCallback, useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import {
  AlertCircle,
  CheckCircle2,
  Clock,
  CreditCard,
  FileText,
  Loader2,
} from 'lucide-react';
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

export const Route = createFileRoute('/portal/billing-update/$tokenId')({
  component: BillingUpdatePortalPage,
});

function BillingUpdatePortalPage() {
  const { tokenId } = Route.useParams();
  const pageUrl =
    typeof window !== 'undefined' ? window.location.href : '';
  return <BillingUpdatePortalScreen tokenId={tokenId} pageUrl={pageUrl} />;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RequestType = 'billing_contact' | 'payment_detail';

export interface BillingContactFields {
  billingName: string;
  billingEmail: string;
  billingPhone: string;
  billingAddress: string;
}

export interface PaymentDetailFields {
  paymentMethod: string;
  paymentReference: string;
  preferredPaymentTerms: string;
}

export interface BillingUpdatePortalScreenProps {
  tokenId: string;
  /** Override the page URL for testing (defaults to window.location.href). */
  pageUrl?: string;
}

export interface SubmitResult {
  requestId: string;
  status: string;
  submittedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function extractBillingUpdateToken(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hashParams = new URLSearchParams(parsed.hash.slice(1));
    const token = hashParams.get('token');
    return token && token.trim().length > 0 ? token.trim() : null;
  } catch {
    return null;
  }
}

function isBillingTokenDenied(message: string | null): boolean {
  if (!message) return false;
  return /billing update token (?:is required|is invalid|has been revoked|has expired)/i.test(
    message,
  );
}

const EMPTY_BILLING_CONTACT: BillingContactFields = {
  billingName: '',
  billingEmail: '',
  billingPhone: '',
  billingAddress: '',
};

const EMPTY_PAYMENT_DETAIL: PaymentDetailFields = {
  paymentMethod: '',
  paymentReference: '',
  preferredPaymentTerms: '',
};

// ---------------------------------------------------------------------------
// Main screen (exported for testing)
// ---------------------------------------------------------------------------

export function BillingUpdatePortalScreen({ pageUrl }: BillingUpdatePortalScreenProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<SubmitResult | null>(null);
  const [requestType, setRequestType] = useState<RequestType>('billing_contact');
  const [billingContact, setBillingContact] = useState<BillingContactFields>(
    EMPTY_BILLING_CONTACT,
  );
  const [paymentDetail, setPaymentDetail] = useState<PaymentDetailFields>(
    EMPTY_PAYMENT_DETAIL,
  );
  const [note, setNote] = useState('');

  const [billingToken] = useState(() =>
    extractBillingUpdateToken(
      pageUrl ?? (typeof window !== 'undefined' ? window.location.href : ''),
    ),
  );
  const [tokenDenied, setTokenDenied] = useState(() => billingToken === null);
  const tokenMissing = billingToken === null;

  // Scrub the raw bearer token from the address bar once captured in memory.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.hash.includes('token=')) {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      );
    }
  }, []);

  // Reset error when any form field changes
  useEffect(() => {
    setSubmitError(null);
  }, [requestType, billingContact, paymentDetail, note]);

  const handleBillingContactChange = useCallback(
    (field: keyof BillingContactFields) =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        setBillingContact((prev) => ({ ...prev, [field]: e.target.value }));
      },
    [],
  );

  const handlePaymentDetailChange = useCallback(
    (field: keyof PaymentDetailFields) =>
      (e: React.ChangeEvent<HTMLInputElement>) => {
        setPaymentDetail((prev) => ({ ...prev, [field]: e.target.value }));
      },
    [],
  );

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();

      if (!billingToken) {
        setSubmitError(
          'No billing update token found in the URL. Please use the link from your email or SMS.',
        );
        setTokenDenied(true);
        return;
      }

      setIsSubmitting(true);
      setSubmitError(null);

      const params: Record<string, string | null> = {
        p_token: billingToken,
        p_request_type: requestType,
        p_note: note.trim() || null,
        p_billing_name: null,
        p_billing_email: null,
        p_billing_phone: null,
        p_billing_address: null,
        p_payment_method: null,
        p_payment_reference: null,
        p_preferred_payment_terms: null,
      };

      if (requestType === 'billing_contact') {
        params.p_billing_name = billingContact.billingName.trim() || null;
        params.p_billing_email = billingContact.billingEmail.trim() || null;
        params.p_billing_phone = billingContact.billingPhone.trim() || null;
        params.p_billing_address = billingContact.billingAddress.trim() || null;
      } else {
        params.p_payment_method = paymentDetail.paymentMethod.trim() || null;
        params.p_payment_reference = paymentDetail.paymentReference.trim() || null;
        params.p_preferred_payment_terms =
          paymentDetail.preferredPaymentTerms.trim() || null;
      }

      const { data, error } = await supabase.rpc(
        'portal_submit_billing_update_request',
        params,
      );

      setIsSubmitting(false);

      if (error) {
        const message =
          (error as { message?: string }).message ??
          'Submission failed. Please try again.';
        setSubmitError(message);
        setTokenDenied(isBillingTokenDenied(message));
        return;
      }

      const row = Array.isArray(data) ? data[0] : data;
      setTokenDenied(false);
      setSubmitResult({
        requestId: String(row?.request_id ?? ''),
        status: String(row?.status ?? 'pending'),
        submittedAt: String(row?.submitted_at ?? ''),
      });
    },
    [billingToken, requestType, billingContact, paymentDetail, note],
  );

  // Success screen
  if (submitResult) {
    return (
      <div
        className="min-h-screen bg-gray-50 flex items-center justify-center p-4"
        data-testid="billing-update-portal-page"
      >
        <Card className="w-full max-w-lg">
          <CardContent className="pt-8 pb-8 flex flex-col items-center gap-4 text-center">
            <CheckCircle2
              className="h-12 w-12 text-green-600"
              aria-hidden="true"
            />
            <h1
              className="text-xl font-semibold"
              data-testid="billing-update-success-heading"
            >
              Request received
            </h1>
            <p className="text-sm text-muted-foreground">
              Your update request has been submitted and is pending internal
              review. Our team will review it shortly. No changes take effect
              until a reviewer approves the request.
            </p>
            <div className="w-full text-left bg-gray-100 rounded-md p-3">
              <p className="text-xs text-gray-500 mb-1">Reference number</p>
              <p
                className="text-sm font-mono text-gray-700 break-all"
                data-testid="billing-update-request-id"
              >
                {submitResult.requestId}
              </p>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Clock className="h-4 w-4" aria-hidden="true" />
              <span>Status: <strong>Pending review</strong></span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isFormDisabled = tokenMissing || tokenDenied || isSubmitting;

  return (
    <div
      className="min-h-screen bg-gray-50 flex items-center justify-center p-4"
      data-testid="billing-update-portal-page"
    >
      <Card className="w-full max-w-lg">
        <CardHeader className="pb-2">
          <div className="flex items-center gap-3">
            <CreditCard
              className="h-6 w-6 text-blue-600"
              aria-hidden="true"
            />
            <div>
              <CardTitle
                className="text-lg leading-tight"
                data-testid="billing-update-form-title"
              >
                Billing &amp; Payment Update
              </CardTitle>
              <p className="text-sm text-muted-foreground mt-0.5">
                Submit a request to update your billing contact or payment
                details. All changes require internal approval before taking
                effect.
              </p>
            </div>
          </div>
          <Badge className="self-start mt-2 bg-blue-100 text-blue-800 hover:bg-blue-100">
            Secure update form
          </Badge>
        </CardHeader>

        <CardContent>
          {tokenMissing && (
            <Alert
              variant="destructive"
              className="mb-4"
              data-testid="token-missing-error"
            >
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Invalid link</AlertTitle>
              <AlertDescription>
                This link is missing a secure token. Please use the original
                link from your email or SMS message.
              </AlertDescription>
            </Alert>
          )}

          {submitError && (
            <Alert
              variant="destructive"
              className="mb-4"
              data-testid="submit-error"
            >
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>
                {tokenDenied ? 'Invalid or expired link' : 'Submission failed'}
              </AlertTitle>
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}

          <form
            onSubmit={(e) => void handleSubmit(e)}
            noValidate
            data-testid="billing-update-form"
          >
            <fieldset disabled={isFormDisabled}>
              {/* Request type selector */}
              <section
                aria-labelledby="request-type-label"
                className="mb-5"
              >
                <h2
                  id="request-type-label"
                  className="text-sm font-medium text-gray-700 mb-3"
                >
                  What would you like to update?
                </h2>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => setRequestType('billing_contact')}
                    disabled={isFormDisabled}
                    data-testid="select-billing-contact"
                    className={`flex flex-col items-center gap-2 p-3 rounded-lg border-2 text-sm font-medium transition-colors
                      ${requestType === 'billing_contact'
                        ? 'border-blue-600 bg-blue-50 text-blue-700'
                        : 'border-gray-200 hover:border-gray-300 text-gray-600'
                      }`}
                    aria-pressed={requestType === 'billing_contact'}
                  >
                    <FileText className="h-5 w-5" aria-hidden="true" />
                    Billing contact
                  </button>
                  <button
                    type="button"
                    onClick={() => setRequestType('payment_detail')}
                    disabled={isFormDisabled}
                    data-testid="select-payment-detail"
                    className={`flex flex-col items-center gap-2 p-3 rounded-lg border-2 text-sm font-medium transition-colors
                      ${requestType === 'payment_detail'
                        ? 'border-blue-600 bg-blue-50 text-blue-700'
                        : 'border-gray-200 hover:border-gray-300 text-gray-600'
                      }`}
                    aria-pressed={requestType === 'payment_detail'}
                  >
                    <CreditCard className="h-5 w-5" aria-hidden="true" />
                    Payment details
                  </button>
                </div>
              </section>

              {/* Billing contact fields */}
              {requestType === 'billing_contact' && (
                <section
                  aria-labelledby="billing-contact-section-label"
                  className="mb-5"
                >
                  <h2
                    id="billing-contact-section-label"
                    className="text-sm font-medium text-gray-700 mb-3"
                  >
                    Updated billing contact
                    <span className="font-normal text-gray-500 ml-1">
                      (leave blank to keep current)
                    </span>
                  </h2>
                  <div className="space-y-3">
                    <div>
                      <Label htmlFor="billing-name">Billing name</Label>
                      <Input
                        id="billing-name"
                        data-testid="input-billing-name"
                        placeholder="Acme Corp – Accounts Payable"
                        value={billingContact.billingName}
                        onChange={handleBillingContactChange('billingName')}
                        autoComplete="organization"
                      />
                    </div>
                    <div>
                      <Label htmlFor="billing-email">Billing email</Label>
                      <Input
                        id="billing-email"
                        data-testid="input-billing-email"
                        type="email"
                        placeholder="ap@example.com"
                        value={billingContact.billingEmail}
                        onChange={handleBillingContactChange('billingEmail')}
                        autoComplete="email"
                      />
                    </div>
                    <div>
                      <Label htmlFor="billing-phone">Billing phone</Label>
                      <Input
                        id="billing-phone"
                        data-testid="input-billing-phone"
                        type="tel"
                        placeholder="555-000-1234"
                        value={billingContact.billingPhone}
                        onChange={handleBillingContactChange('billingPhone')}
                        autoComplete="tel"
                      />
                    </div>
                    <div>
                      <Label htmlFor="billing-address">Billing address</Label>
                      <Input
                        id="billing-address"
                        data-testid="input-billing-address"
                        placeholder="123 Main St, City, TX 75000"
                        value={billingContact.billingAddress}
                        onChange={handleBillingContactChange('billingAddress')}
                        autoComplete="street-address"
                      />
                    </div>
                  </div>
                </section>
              )}

              {/* Payment detail fields */}
              {requestType === 'payment_detail' && (
                <section
                  aria-labelledby="payment-detail-section-label"
                  className="mb-5"
                >
                  <h2
                    id="payment-detail-section-label"
                    className="text-sm font-medium text-gray-700 mb-3"
                  >
                    Updated payment details
                    <span className="font-normal text-gray-500 ml-1">
                      (leave blank to keep current)
                    </span>
                  </h2>
                  <div className="space-y-3">
                    <div>
                      <Label htmlFor="payment-method">Payment method</Label>
                      <Input
                        id="payment-method"
                        data-testid="input-payment-method"
                        placeholder="e.g. ACH, wire transfer, cheque"
                        value={paymentDetail.paymentMethod}
                        onChange={handlePaymentDetailChange('paymentMethod')}
                      />
                    </div>
                    <div>
                      <Label htmlFor="payment-reference">Payment reference</Label>
                      <Input
                        id="payment-reference"
                        data-testid="input-payment-reference"
                        placeholder="PO number or reference"
                        value={paymentDetail.paymentReference}
                        onChange={handlePaymentDetailChange('paymentReference')}
                      />
                    </div>
                    <div>
                      <Label htmlFor="preferred-payment-terms">
                        Preferred payment terms
                      </Label>
                      <Input
                        id="preferred-payment-terms"
                        data-testid="input-preferred-payment-terms"
                        placeholder="e.g. NET30, NET45"
                        value={paymentDetail.preferredPaymentTerms}
                        onChange={handlePaymentDetailChange(
                          'preferredPaymentTerms',
                        )}
                      />
                    </div>
                  </div>
                </section>
              )}

              {/* Optional note */}
              <section aria-labelledby="note-section-label" className="mb-6">
                <h2
                  id="note-section-label"
                  className="text-sm font-medium text-gray-700 mb-2"
                >
                  Additional note{' '}
                  <span className="font-normal text-gray-500">(optional)</span>
                </h2>
                <Input
                  id="billing-update-note"
                  data-testid="input-note"
                  placeholder="Any additional context for the reviewer"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </section>

              <Alert className="mb-4 border-amber-200 bg-amber-50">
                <Clock className="h-4 w-4 text-amber-600" />
                <AlertTitle className="text-amber-800">
                  Pending review
                </AlertTitle>
                <AlertDescription className="text-amber-700">
                  Your request will be reviewed by our team before any changes
                  take effect. You will be notified once a decision is made.
                </AlertDescription>
              </Alert>

              <Button
                type="submit"
                className="w-full"
                disabled={isFormDisabled}
                data-testid="submit-button"
              >
                {isSubmitting ? (
                  <>
                    <Loader2
                      className="h-4 w-4 mr-2 animate-spin"
                      aria-hidden="true"
                    />
                    Submitting…
                  </>
                ) : (
                  'Submit update request'
                )}
              </Button>
            </fieldset>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
