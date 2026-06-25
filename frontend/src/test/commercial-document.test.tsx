import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  CommercialDocument,
  type CommercialDocumentModel,
} from '@/components/documents/CommercialDocument';

function buildModel(variant: CommercialDocumentModel['variant']): CommercialDocumentModel {
  return {
    variant,
    title: variant === 'quote' ? 'Rental Quote' : 'Reservation Confirmation',
    documentNumber: variant === 'quote' ? 'Q-1001' : 'RC-1001',
    statusLabel: variant === 'quote' ? 'approved' : 'converted',
    issuedAtLabel: 'June 10, 2026',
    rentalPeriodLabel: 'June 12, 2026 – June 19, 2026',
    branding: {
      companyName: 'Wynne Systems',
      eyebrow: 'Equipment Rental',
      supportEmail: 'support@wynne.example',
    },
    customer: {
      name: 'Taylor Morgan',
      company: 'Skyline Build Co.',
      email: 'taylor@example.com',
      phone: '+1 (555) 010-1010',
    },
    jobSite: {
      name: 'Downtown Tower',
      address: '100 Main St, Austin, TX',
      reference: 'Gate code 4251',
    },
    lineItems: [
      {
        title: 'Excavator XL',
        description: 'Heavy-duty excavator',
        quantity: 1,
        rentalPeriod: 'June 12, 2026 – June 19, 2026',
        rateLabel: '1.0 weeks × $2,800.00/wk',
        amount: 2200,
      },
    ],
    subtotalAmount: 4200,
    fees: [{ label: 'Environmental fee', amount: 210 }],
    taxes: [{ label: 'Tax', amount: 374.85 }],
    totalAmount: 4784.85,
    notes: 'Leave unit near the west loading area.',
  };
}

describe('CommercialDocument', () => {
  it('renders quote branding, customer context, and mobile-friendly document structure', () => {
    render(<CommercialDocument model={buildModel('quote')} shareUrl="https://example.com/doc" />);

    expect(screen.getByText('Wynne Systems')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rental Quote' })).toBeInTheDocument();
    expect(screen.getByText('Taylor Morgan')).toBeInTheDocument();
    expect(screen.getByText('Downtown Tower')).toBeInTheDocument();
    expect(screen.getByTestId('commercial-document-context-grid')).toHaveClass('grid-cols-1', 'sm:grid-cols-2');
    expect(screen.getByTestId('document-print')).toBeInTheDocument();
    expect(screen.getByTestId('document-copy-link')).toBeInTheDocument();
  });

  it('uses the canonical totals passed to the document instead of recomputing them from line items', () => {
    render(<CommercialDocument model={buildModel('reservation-confirmation')} />);

    expect(screen.getByRole('heading', { name: 'Reservation Confirmation' })).toBeInTheDocument();
    expect(screen.getByText('$4,200.00')).toBeInTheDocument();
    expect(screen.getByText('$210.00')).toBeInTheDocument();
    expect(screen.getByText('$374.85')).toBeInTheDocument();
    expect(screen.getByTestId('commercial-document-total')).toHaveTextContent('$4,784.85');
    expect(screen.getByText('$2,200.00')).toBeInTheDocument();
  });
});
