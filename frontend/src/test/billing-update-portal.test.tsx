import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---------------------------------------------------------------------------
// Hoist mocks before module imports
// ---------------------------------------------------------------------------

const { rpcMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    rpc: rpcMock,
  },
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>(
    '@tanstack/react-router',
  );
  return {
    ...actual,
    createFileRoute: () => () => ({}),
  };
});

import {
  BillingUpdatePortalScreen,
  extractBillingUpdateToken,
} from '@/routes/portal/billing-update/$tokenId';
import opsBillingUpdateQueuePage from '@/pages/ops-billing-update-queue.json';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_ID = 'billing-token-session-abc';
const VALID_TOKEN = 'billing-raw-token-abcdef1234567890abcdef1234567890';
const PAGE_URL_WITH_TOKEN = `http://example.com/portal/billing-update/${TOKEN_ID}#token=${VALID_TOKEN}`;
const PAGE_URL_NO_TOKEN = `http://example.com/portal/billing-update/${TOKEN_ID}`;

function mockSubmitSuccess() {
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'portal_submit_billing_update_request') {
      return Promise.resolve({
        data: [
          {
            request_id: 'req-00000000-0000-0000-0000-000000000001',
            status: 'pending',
            submitted_at: '2026-06-15T00:00:00.000Z',
          },
        ],
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

function mockSubmitError(message: string) {
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'portal_submit_billing_update_request') {
      return Promise.resolve({ data: null, error: { message } });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

// ---------------------------------------------------------------------------
// extractBillingUpdateToken
// ---------------------------------------------------------------------------

describe('extractBillingUpdateToken', () => {
  it('returns the token from the URL fragment', () => {
    expect(extractBillingUpdateToken(PAGE_URL_WITH_TOKEN)).toBe(VALID_TOKEN);
  });

  it('returns null when the token fragment param is absent', () => {
    expect(extractBillingUpdateToken(PAGE_URL_NO_TOKEN)).toBeNull();
  });

  it('returns null for an empty token value', () => {
    expect(
      extractBillingUpdateToken(
        `http://example.com/portal/billing-update/${TOKEN_ID}#token=`,
      ),
    ).toBeNull();
  });

  it('returns null for a whitespace-only token', () => {
    expect(
      extractBillingUpdateToken(
        `http://example.com/portal/billing-update/${TOKEN_ID}#token=   `,
      ),
    ).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(extractBillingUpdateToken('not-a-url')).toBeNull();
  });

  it('trims surrounding whitespace from the token', () => {
    expect(
      extractBillingUpdateToken(
        `http://example.com/portal/billing-update/${TOKEN_ID}#token=  abc123  `,
      ),
    ).toBe('abc123');
  });
});

// ---------------------------------------------------------------------------
// BillingUpdatePortalScreen – token-missing state
// ---------------------------------------------------------------------------

describe('BillingUpdatePortalScreen – token missing', () => {
  it('renders the page container', () => {
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_NO_TOKEN}
      />,
    );
    expect(screen.getByTestId('billing-update-portal-page')).toBeTruthy();
  });

  it('shows the token-missing error alert', () => {
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_NO_TOKEN}
      />,
    );
    expect(screen.getByTestId('token-missing-error')).toBeTruthy();
  });

  it('disables the submit button when token is missing', () => {
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_NO_TOKEN}
      />,
    );
    const btn = screen.getByTestId('submit-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// BillingUpdatePortalScreen – form rendering with valid token
// ---------------------------------------------------------------------------

describe('BillingUpdatePortalScreen – form with valid token', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('shows the form title', () => {
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_WITH_TOKEN}
      />,
    );
    expect(screen.getByTestId('billing-update-form-title')).toBeTruthy();
  });

  it('renders billing contact fields by default', () => {
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_WITH_TOKEN}
      />,
    );
    expect(screen.getByTestId('input-billing-name')).toBeTruthy();
    expect(screen.getByTestId('input-billing-email')).toBeTruthy();
    expect(screen.getByTestId('input-billing-phone')).toBeTruthy();
    expect(screen.getByTestId('input-billing-address')).toBeTruthy();
  });

  it('switches to payment detail fields when payment detail is selected', async () => {
    const user = userEvent.setup();
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_WITH_TOKEN}
      />,
    );
    await user.click(screen.getByTestId('select-payment-detail'));
    expect(screen.getByTestId('input-payment-method')).toBeTruthy();
    expect(screen.getByTestId('input-payment-reference')).toBeTruthy();
    expect(screen.getByTestId('input-preferred-payment-terms')).toBeTruthy();
  });

  it('enables the submit button when token is present', () => {
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_WITH_TOKEN}
      />,
    );
    const btn = screen.getByTestId('submit-button') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it('shows the pending-review notice', () => {
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_WITH_TOKEN}
      />,
    );
    expect(screen.getByText(/pending review/i)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// BillingUpdatePortalScreen – successful submission
// ---------------------------------------------------------------------------

describe('BillingUpdatePortalScreen – successful billing contact submission', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    mockSubmitSuccess();
  });

  it('shows success heading after submission', async () => {
    const user = userEvent.setup();
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_WITH_TOKEN}
      />,
    );

    await user.type(
      screen.getByTestId('input-billing-email'),
      'ap-new@example.com',
    );
    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('billing-update-success-heading')).toBeTruthy();
    });
  });

  it('calls portal_submit_billing_update_request with billing_contact type', async () => {
    const user = userEvent.setup();
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_WITH_TOKEN}
      />,
    );

    await user.type(screen.getByTestId('input-billing-name'), 'Acme AP');
    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'portal_submit_billing_update_request',
        expect.objectContaining({
          p_token: VALID_TOKEN,
          p_request_type: 'billing_contact',
          p_billing_name: 'Acme AP',
        }),
      );
    });
  });

  it('shows the returned request ID in the success view', async () => {
    const user = userEvent.setup();
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_WITH_TOKEN}
      />,
    );

    await user.type(
      screen.getByTestId('input-billing-address'),
      '123 Main St',
    );
    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('billing-update-request-id').textContent).toBe(
        'req-00000000-0000-0000-0000-000000000001',
      );
    });
  });

  it('submits payment detail request type when selected', async () => {
    const user = userEvent.setup();
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_WITH_TOKEN}
      />,
    );

    await user.click(screen.getByTestId('select-payment-detail'));
    await user.type(screen.getByTestId('input-payment-method'), 'ACH');
    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'portal_submit_billing_update_request',
        expect.objectContaining({
          p_request_type: 'payment_detail',
          p_payment_method: 'ACH',
          p_billing_name: null,
        }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// BillingUpdatePortalScreen – submission errors
// ---------------------------------------------------------------------------

describe('BillingUpdatePortalScreen – submission errors', () => {
  beforeEach(() => {
    rpcMock.mockReset();
  });

  it('shows generic error on network failure', async () => {
    const user = userEvent.setup();
    mockSubmitError('Network error');
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_WITH_TOKEN}
      />,
    );

    await user.type(screen.getByTestId('input-billing-email'), 'test@example.com');
    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toBeTruthy();
    });
    expect(screen.getByText('Network error')).toBeTruthy();
  });

  it('shows token-denied message on invalid/expired token error', async () => {
    const user = userEvent.setup();
    mockSubmitError('Billing update token has expired');
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_WITH_TOKEN}
      />,
    );

    await user.type(screen.getByTestId('input-billing-name'), 'test');
    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(screen.getByText('Invalid or expired link')).toBeTruthy();
    });
  });

  it('clears error when form changes after failure', async () => {
    const user = userEvent.setup();
    mockSubmitError('Something went wrong');
    render(
      <BillingUpdatePortalScreen
        tokenId={TOKEN_ID}
        pageUrl={PAGE_URL_WITH_TOKEN}
      />,
    );

    await user.type(screen.getByTestId('input-billing-email'), 'a@b.com');
    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toBeTruthy();
    });

    // Changing a field should clear the error
    await user.clear(screen.getByTestId('input-billing-email'));
    await user.type(screen.getByTestId('input-billing-email'), 'changed@b.com');

    await waitFor(() => {
      expect(screen.queryByTestId('submit-error')).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// BillingUpdatePortalScreen – ops queue route
// ---------------------------------------------------------------------------

describe('BillingUpdateQueueScreen', () => {
  it('the ops billing-updates module exports BillingUpdateQueueScreen', async () => {
    const mod = await import('@/routes/ops/billing-updates');
    expect(typeof mod.BillingUpdateQueueScreen).toBe('function');
  });

  it('queue page definition surfaces readable account context and review handoff actions', () => {
    const pageJson = JSON.stringify(opsBillingUpdateQueuePage);
    expect(pageJson).not.toContain('Billing account: {{req.billing_account_id}}');
    expect(pageJson).not.toContain('Customer: {{req.customer_id}}');
    expect(pageJson).toContain(
      'Billing account: {{req.requested_fields?.billing_account_label || (req.billing_account_id ? `Account ${req.billing_account_id.slice(0, 8).toUpperCase()}` : \'Account unavailable\')}}',
    );
    expect(pageJson).toContain(
      'Customer: {{req.requested_fields?.customer_label || (req.customer_id ? `Customer ${req.customer_id.slice(0, 8).toUpperCase()}` : \'Customer unavailable\')}}',
    );
    expect(pageJson).toContain('Review request');
    expect(pageJson).toContain('Approve handoff');
  });
});
