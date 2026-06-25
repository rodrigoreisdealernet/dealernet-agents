import { type ReactNode, useCallback, useState } from 'react';
import { Check, Copy, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export interface CommercialDocumentBranding {
  companyName: string;
  eyebrow?: string;
  supportEmail?: string;
  supportPhone?: string;
  logoUrl?: string;
}

export interface CommercialDocumentLineItem {
  title: string;
  description?: string;
  quantity?: number | null;
  rentalPeriod?: string;
  rateLabel?: string;
  amount?: number | null;
}

export interface CommercialDocumentMoneyRow {
  label: string;
  amount: number;
}

export interface CommercialDocumentParty {
  name?: string;
  company?: string;
  email?: string;
  phone?: string;
}

export interface CommercialDocumentLocation {
  name?: string;
  address?: string;
  reference?: string;
}

export interface CommercialDocumentModel {
  variant: 'quote' | 'reservation-confirmation';
  title: string;
  documentNumber?: string;
  statusLabel?: string;
  issuedAtLabel?: string;
  rentalPeriodLabel?: string;
  branding: CommercialDocumentBranding;
  customer: CommercialDocumentParty;
  jobSite?: CommercialDocumentLocation;
  lineItems: CommercialDocumentLineItem[];
  subtotalAmount?: number | null;
  fees?: CommercialDocumentMoneyRow[];
  taxes?: CommercialDocumentMoneyRow[];
  totalAmount?: number | null;
  notes?: string;
}

export function formatCurrency(value: number | null | undefined): string {
  if (typeof value !== 'number' || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function DetailBlock({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <div className="text-sm text-foreground">{children}</div>
    </div>
  );
}

export function CopyDocumentLinkButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // ignore clipboard failures
    }
  }, [url]);

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="print:hidden"
      onClick={() => void handleCopy()}
      data-testid="document-copy-link"
    >
      {copied ? (
        <>
          <Check className="mr-1.5 h-3.5 w-3.5" />
          Copied
        </>
      ) : (
        <>
          <Copy className="mr-1.5 h-3.5 w-3.5" />
          Copy link
        </>
      )}
    </Button>
  );
}

export function PrintDocumentButton() {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="print:hidden"
      onClick={() => window.print()}
      data-testid="document-print"
    >
      <Printer className="mr-1.5 h-3.5 w-3.5" />
      Print / Save PDF
    </Button>
  );
}

export function CommercialDocument({
  model,
  shareUrl,
}: {
  model: CommercialDocumentModel;
  shareUrl?: string;
}) {
  const variantLabel =
    model.variant === 'reservation-confirmation'
      ? 'Reservation confirmation'
      : 'Quote document';

  return (
    <Card
      className="mx-auto w-full max-w-4xl border-primary/10 bg-white shadow-sm print:max-w-none print:border-0 print:shadow-none"
      data-testid="commercial-document"
    >
      <CardContent className="space-y-6 p-4 sm:p-6 lg:p-8">
        <div className="flex flex-col gap-3 border-b pb-4 print:hidden sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-primary">
              {variantLabel}
            </p>
            <h2 className="text-xl font-bold">{model.title}</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            {shareUrl ? <CopyDocumentLinkButton url={shareUrl} /> : null}
            <PrintDocumentButton />
          </div>
        </div>

        <div className="flex flex-col gap-4 border-b pb-6 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              {model.branding.logoUrl ? (
                <img
                  src={model.branding.logoUrl}
                  alt={model.branding.companyName}
                  className="h-10 w-10 rounded-lg border object-cover"
                />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-foreground">
                  {model.branding.companyName.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div>
                <h1 className="text-lg font-bold">{model.branding.companyName}</h1>
                <p className="text-sm text-muted-foreground">
                  {model.branding.eyebrow || 'Equipment Rental'}
                </p>
              </div>
            </div>
            {(model.branding.supportEmail || model.branding.supportPhone) && (
              <p className="text-sm text-muted-foreground">
                {[model.branding.supportEmail, model.branding.supportPhone]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            )}
          </div>

          <div className="space-y-1 text-sm sm:text-right">
            <p className="font-semibold">{model.title}</p>
            {model.documentNumber ? <p>Reference: {model.documentNumber}</p> : null}
            {model.statusLabel ? <p className="text-muted-foreground">Status: {model.statusLabel}</p> : null}
            {model.issuedAtLabel ? (
              <p className="text-muted-foreground">Issued: {model.issuedAtLabel}</p>
            ) : null}
            {model.rentalPeriodLabel ? (
              <p className="text-muted-foreground">Rental: {model.rentalPeriodLabel}</p>
            ) : null}
          </div>
        </div>

        <div
          className="grid grid-cols-1 gap-4 sm:grid-cols-2"
          data-testid="commercial-document-context-grid"
        >
          <DetailBlock label="Customer">
            <div className="space-y-1">
              {model.customer.name ? <p className="font-medium">{model.customer.name}</p> : null}
              {model.customer.company ? <p>{model.customer.company}</p> : null}
              {model.customer.email ? <p>{model.customer.email}</p> : null}
              {model.customer.phone ? <p>{model.customer.phone}</p> : null}
              {!model.customer.name &&
              !model.customer.company &&
              !model.customer.email &&
              !model.customer.phone ? (
                <p className="text-muted-foreground">Customer details not provided.</p>
              ) : null}
            </div>
          </DetailBlock>

          <DetailBlock label="Job site">
            <div className="space-y-1">
              {model.jobSite?.name ? <p className="font-medium">{model.jobSite.name}</p> : null}
              {model.jobSite?.address ? <p>{model.jobSite.address}</p> : null}
              {model.jobSite?.reference ? <p>{model.jobSite.reference}</p> : null}
              {!model.jobSite?.name && !model.jobSite?.address && !model.jobSite?.reference ? (
                <p className="text-muted-foreground">Job-site details not provided.</p>
              ) : null}
            </div>
          </DetailBlock>
        </div>

        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-base font-semibold">Commercial summary</h3>
            <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">
              Canonical snapshot
            </p>
          </div>

          <div className="overflow-hidden rounded-xl border">
            <div className="hidden grid-cols-[minmax(0,1.7fr)_0.8fr_0.9fr_0.8fr] gap-4 border-b bg-muted/40 px-4 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground md:grid">
              <span>Item</span>
              <span>Period</span>
              <span>Rate</span>
              <span className="text-right">Amount</span>
            </div>

            <div className="divide-y">
              {model.lineItems.map((item, index) => (
                <div
                  key={`${item.title}-${index}`}
                  className="grid gap-2 px-4 py-4 md:grid-cols-[minmax(0,1.7fr)_0.8fr_0.9fr_0.8fr] md:items-start md:gap-4"
                  data-testid={`commercial-line-item-${index}`}
                >
                  <div>
                    <p className="font-medium">{item.title}</p>
                    {item.description ? (
                      <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                    ) : null}
                    {typeof item.quantity === 'number' ? (
                      <p className="mt-1 text-xs text-muted-foreground">Qty {item.quantity}</p>
                    ) : null}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    <span className="mr-2 font-semibold text-foreground md:hidden">Period:</span>
                    {item.rentalPeriod || '—'}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    <span className="mr-2 font-semibold text-foreground md:hidden">Rate:</span>
                    {item.rateLabel || '—'}
                  </p>
                  <p className="text-sm font-medium md:text-right">
                    <span className="mr-2 font-semibold text-foreground md:hidden">Amount:</span>
                    {formatCurrency(item.amount)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="space-y-2">
            {model.notes ? (
              <DetailBlock label="Notes">
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">{model.notes}</p>
              </DetailBlock>
            ) : null}
          </div>

          <div className="rounded-xl border bg-muted/20 p-4">
            <div className="space-y-2 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="text-muted-foreground">Rental subtotal</span>
                <span>{formatCurrency(model.subtotalAmount)}</span>
              </div>
              {(model.fees || []).map((fee) => (
                <div key={fee.label} className="flex items-center justify-between gap-3 text-muted-foreground">
                  <span>{fee.label}</span>
                  <span>{formatCurrency(fee.amount)}</span>
                </div>
              ))}
              {(model.taxes || []).map((tax) => (
                <div key={tax.label} className="flex items-center justify-between gap-3 text-muted-foreground">
                  <span>{tax.label}</span>
                  <span>{formatCurrency(tax.amount)}</span>
                </div>
              ))}
              <div className="flex items-center justify-between gap-3 border-t pt-3 text-base font-semibold">
                <span>Total</span>
                <span data-testid="commercial-document-total">{formatCurrency(model.totalAmount)}</span>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
