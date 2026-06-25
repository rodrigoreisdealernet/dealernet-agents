/**
 * Rental Order Detail Route
 */

import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { UIEngine } from '@/engine';
import { useDataSources } from '@/engine/useDataSources';
import rentalOrderDetailPage from '@/pages/rental-order-detail.json';
import type { ExpressionContext, PageDefinition } from '@/engine/types';
import { Button } from '@/components/ui/button';
import { ConflictAssistantPanel } from '@/components/rental/ConflictAssistantPanel';
import {
  CommercialDocument,
  type CommercialDocumentBranding,
  type CommercialDocumentLineItem,
  type CommercialDocumentModel,
  type CommercialDocumentMoneyRow,
} from '@/components/documents/CommercialDocument';
import { buildBookingConflictAssistant } from '@/lib/bookingConflictAssistant';

export const Route = createFileRoute('/rental/orders/$id')({
  component: RentalOrderDetailPage,
});

interface RentalOrderDetailScreenProps {
  id: string;
}

type LooseRecord = Record<string, unknown>;

function asRecord(value: unknown): LooseRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as LooseRecord) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function formatDateLabel(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function mergeBranding(
  branding: LooseRecord | null | undefined,
  fallbackName: string | undefined,
): CommercialDocumentBranding {
  return {
    companyName: asString(branding?.company_name) || fallbackName || 'Dealernet',
    eyebrow: asString(branding?.eyebrow) || 'Equipment Rental',
    supportEmail: asString(branding?.support_email),
    supportPhone: asString(branding?.support_phone),
    logoUrl: asString(branding?.logo_url),
  };
}

function mapMoneyRows(value: unknown): CommercialDocumentMoneyRow[] {
  return asArray(value)
    .map((row) => {
      const record = asRecord(row);
      const label = asString(record?.label);
      const amount = asNumber(record?.amount);
      if (!label || amount === undefined) return null;
      return { label, amount };
    })
    .filter((row): row is CommercialDocumentMoneyRow => row !== null);
}

function mapFallbackLineItems(orderData: LooseRecord, entityLines: unknown[]): CommercialDocumentLineItem[] {
  const inlineLines = asArray(orderData.lines);
  const sourceLines: LooseRecord[] = (entityLines.length > 0
    ? entityLines.map((line) => asRecord(asArray(asRecord(line)?.entity_versions)[0])?.data)
    : inlineLines.map((line) => asRecord(line))
  ).filter((line): line is LooseRecord => line !== null);

  return sourceLines.map((line, index) => {
    const start = asString(line?.planned_start);
    const end = asString(line?.planned_end);
    const rentalPeriod = [formatDateLabel(start), formatDateLabel(end)].filter(Boolean).join(' – ');
    return {
      title: asString(line?.name) || asString(line?.category_name) || asString(line?.category_id) || `Line ${index + 1}`,
      description: asString(line?.job_site_name) || asString(line?.job_site_id),
      quantity: asNumber(line?.quantity) ?? null,
      rentalPeriod: rentalPeriod || undefined,
      rateLabel: asString(line?.rate_label) || asString(line?.rate_type),
      amount: asNumber(line?.amount) ?? asNumber(line?.extended_amount) ?? asNumber(line?.subtotal) ?? null,
    };
  });
}

function buildRentalOrderDocumentModel(data: Record<string, unknown>): CommercialDocumentModel | null {
  const order = asRecord(data.order);
  const version = asRecord(asArray(order?.entity_versions)[0]);
  const orderData = asRecord(version?.data);
  if (!orderData) return null;

  const snapshot = asRecord(orderData.commercial_snapshot);
  const entityLines = asArray(data.lines);
  const variant =
    asString(orderData.status) === 'converted' ? 'reservation-confirmation' : 'quote';

  const lineItems = asArray(snapshot?.line_items)
    .flatMap<CommercialDocumentLineItem>((item) => {
      const record = asRecord(item);
      const title = asString(record?.title);
      if (!title) return [];
      return [{
        title,
        description: asString(record?.description),
        quantity: asNumber(record?.quantity) ?? null,
        rentalPeriod: asString(record?.rental_period),
        rateLabel: asString(record?.rate_label),
        amount: asNumber(record?.amount) ?? null,
      }];
    });

  const fees = mapMoneyRows(snapshot?.fees);
  const taxes = mapMoneyRows(snapshot?.taxes);
  const envFee = asNumber(snapshot?.env_fee) ?? asNumber(orderData.env_fee);
  const taxAmount = asNumber(snapshot?.tax) ?? asNumber(snapshot?.tax_amount) ?? asNumber(orderData.tax) ?? asNumber(orderData.tax_amount);
  if (envFee !== undefined && !fees.some((fee) => fee.label === 'Environmental fee')) {
    fees.push({ label: 'Environmental fee', amount: envFee });
  }
  if (taxAmount !== undefined && taxes.length === 0) {
    taxes.push({ label: 'Tax', amount: taxAmount });
  }

  const documentNumber =
    asString(snapshot?.document_number) ||
    asString(snapshot?.quote_number) ||
    asString(snapshot?.reservation_number) ||
    asString(orderData.order_number);

  return {
    variant,
    title: variant === 'reservation-confirmation' ? 'Reservation Confirmation' : 'Approved Quote',
    documentNumber,
    statusLabel: asString(orderData.status),
    issuedAtLabel:
      formatDateLabel(asString(snapshot?.issued_at) || asString(order?.created_at)) || undefined,
    rentalPeriodLabel:
      asString(snapshot?.rental_period) ||
      [formatDateLabel(asString(orderData.term_start)), formatDateLabel(asString(orderData.term_end))]
        .filter(Boolean)
        .join(' – ') ||
      undefined,
    branding: mergeBranding(asRecord(snapshot?.branding) || asRecord(orderData.document_branding), asString(orderData.account_name)),
    customer: {
      name: asString(snapshot?.customer_name) || asString(orderData.customer_name) || asString(orderData.requester_name) || asString(orderData.requester_id),
      company: asString(snapshot?.customer_company) || asString(orderData.customer_company),
      email: asString(snapshot?.customer_email) || asString(orderData.requester_email),
      phone: asString(snapshot?.customer_phone) || asString(orderData.requester_phone),
    },
    jobSite: {
      name: asString(snapshot?.job_site_name) || asString(orderData.job_site_name) || asString(orderData.job_site_id),
      address: asString(snapshot?.job_site_address) || asString(orderData.job_site_address),
      reference: asString(snapshot?.job_site_reference),
    },
    lineItems: lineItems.length > 0 ? lineItems : mapFallbackLineItems(orderData, entityLines),
    subtotalAmount:
      asNumber(snapshot?.subtotal) ??
      asNumber(snapshot?.base_amount) ??
      asNumber(orderData.subtotal) ??
      asNumber(orderData.base_amount) ??
      null,
    fees,
    taxes,
    totalAmount:
      asNumber(snapshot?.total) ??
      asNumber(snapshot?.total_amount) ??
      asNumber(orderData.total) ??
      asNumber(orderData.total_amount) ??
      null,
    notes: asString(snapshot?.notes) || asString(orderData.notes),
  };
}

function RentalOrderDocumentLauncher({ id }: { id: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const page = rentalOrderDetailPage as PageDefinition;
  const context = useMemo<ExpressionContext>(
    () => ({
      state: page.state || {},
      data: {},
      params: { id },
    }),
    [id, page.state],
  );
  const { data } = useDataSources(page.dataSources, context);
  const model = useMemo(() => buildRentalOrderDocumentModel(data), [data]);

  if (!model) return null;

  const buttonLabel =
    model.variant === 'reservation-confirmation'
      ? 'Preview reservation confirmation'
      : 'Preview quote document';

  return (
    <section className="mx-auto mt-6 max-w-7xl px-4 sm:px-6 lg:px-8" data-testid="rental-order-document-launcher">
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold">
              {model.variant === 'reservation-confirmation' ? 'Reservation confirmation' : 'Quote document'}
            </h2>
            <p className="text-sm text-muted-foreground">
              Dedicated render surface using the commercial snapshot already attached to this order revision.
            </p>
          </div>
          <Button type="button" onClick={() => setIsOpen((open) => !open)} data-testid="toggle-order-document">
            {isOpen ? 'Hide document preview' : buttonLabel}
          </Button>
        </div>

        {isOpen ? (
          <div className="mt-4" id="reservation-document-preview">
            <CommercialDocument
              model={model}
              shareUrl={typeof window !== 'undefined' ? `${window.location.href}#reservation-document-preview` : undefined}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function RentalOrderConflictAssistant({ id }: { id: string }) {
  const page = rentalOrderDetailPage as PageDefinition;
  const context = useMemo<ExpressionContext>(
    () => ({
      state: page.state || {},
      data: {},
      params: { id },
    }),
    [id, page.state],
  );
  const { data } = useDataSources(page.dataSources, context);
  const result = useMemo(
    () => buildBookingConflictAssistant({
      orderId: id,
      quoteAvailability: data.quote_availability,
      availability: data.availability,
    }),
    [data.availability, data.quote_availability, id],
  );

  return (
    <ConflictAssistantPanel
      title="Booking & extension conflict assistant"
      description="Assist-only review surface for availability blockers and source-backed follow-ups before a quote is confirmed or released."
      result={result}
    />
  );
}

export function RentalOrderDetailScreen({ id }: RentalOrderDetailScreenProps) {
  return (
    <>
      <UIEngine
        page={rentalOrderDetailPage as PageDefinition}
        params={{ id }}
      />
      <RentalOrderConflictAssistant id={id} />
      <RentalOrderDocumentLauncher id={id} />
    </>
  );
}

function RentalOrderDetailPage() {
  const { id } = Route.useParams();
  return <RentalOrderDetailScreen id={id} />;
}
