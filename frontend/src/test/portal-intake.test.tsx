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
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({}),
  };
});

import {
  PortalIntakeScreen,
  extractIntakeToken,
} from '@/routes/portal/intake/$tokenId';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TOKEN_ID = 'token-session-abc';
const VALID_TOKEN = 'intake-raw-token-abcdef1234567890abcdef1234567890';
const PAGE_URL_WITH_TOKEN = `http://example.com/portal/intake/${TOKEN_ID}#token=${VALID_TOKEN}`;
const PAGE_URL_NO_TOKEN = `http://example.com/portal/intake/${TOKEN_ID}`;

function mockSubmitSuccess() {
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'portal_submit_intake') {
      return Promise.resolve({
        data: [
          {
            customer_entity_id: '11111111-0000-0000-0000-000000000001',
            contact_entity_id: '11111111-0000-0000-0000-000000000002',
            job_site_entity_id: null,
            tenant_id: 'tenant-demo',
            submitted_at: '2026-06-10T00:00:00.000Z',
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
    if (fn === 'portal_submit_intake') {
      return Promise.resolve({ data: null, error: { message } });
    }
    return Promise.resolve({ data: null, error: null });
  });
}

// ---------------------------------------------------------------------------
// extractIntakeToken
// ---------------------------------------------------------------------------

describe('extractIntakeToken', () => {
  it('returns the token from the URL fragment', () => {
    expect(extractIntakeToken(PAGE_URL_WITH_TOKEN)).toBe(VALID_TOKEN);
  });

  it('returns null when the token fragment param is absent', () => {
    expect(extractIntakeToken(PAGE_URL_NO_TOKEN)).toBeNull();
  });

  it('returns null for an empty token value', () => {
    expect(extractIntakeToken(`http://example.com/portal/intake/${TOKEN_ID}#token=`)).toBeNull();
  });

  it('returns null for a whitespace-only token value', () => {
    expect(extractIntakeToken(`http://example.com/portal/intake/${TOKEN_ID}#token=%20%20%20`)).toBeNull();
  });

  it('returns null for an invalid URL', () => {
    expect(extractIntakeToken('not-a-url')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PortalIntakeScreen
// ---------------------------------------------------------------------------

describe('PortalIntakeScreen', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    mockSubmitSuccess();
  });

  it('renders the portal intake page container', () => {
    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_WITH_TOKEN} />,
    );
    expect(screen.getByTestId('portal-intake-page')).toBeInTheDocument();
  });

  it('renders the form title', () => {
    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_WITH_TOKEN} />,
    );
    expect(screen.getByTestId('intake-form-title')).toHaveTextContent('Customer Intake');
  });

  it('renders all form input fields', () => {
    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_WITH_TOKEN} />,
    );
    expect(screen.getByTestId('input-customer-name')).toBeInTheDocument();
    expect(screen.getByTestId('input-customer-type')).toBeInTheDocument();
    expect(screen.getByTestId('input-contact-name')).toBeInTheDocument();
    expect(screen.getByTestId('input-contact-email')).toBeInTheDocument();
    expect(screen.getByTestId('input-contact-phone')).toBeInTheDocument();
    expect(screen.getByTestId('input-job-site-name')).toBeInTheDocument();
    expect(screen.getByTestId('input-job-site-address')).toBeInTheDocument();
  });

  it('renders a submit button', () => {
    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_WITH_TOKEN} />,
    );
    expect(screen.getByTestId('submit-button')).toBeInTheDocument();
    expect(screen.getByTestId('submit-button')).not.toBeDisabled();
  });

  it('shows a token-missing error when no token is in the URL', () => {
    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_NO_TOKEN} />,
    );
    expect(screen.getByTestId('token-missing-error')).toBeInTheDocument();
    expect(screen.getByTestId('submit-button')).toBeDisabled();
  });

  it('shows a success confirmation after successful submission', async () => {
    const user = userEvent.setup();
    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_WITH_TOKEN} />,
    );

    await user.type(screen.getByTestId('input-customer-name'), 'Acme Corp');
    await user.type(screen.getByTestId('input-contact-name'), 'Jane Smith');
    await user.type(screen.getByTestId('input-contact-email'), 'jane@acme.example');
    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('intake-success-heading')).toBeInTheDocument();
    });
  });

  it('calls portal_submit_intake RPC with the correct token and form fields', async () => {
    const user = userEvent.setup();
    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_WITH_TOKEN} />,
    );

    await user.type(screen.getByTestId('input-customer-name'), 'Test Corp');
    await user.type(screen.getByTestId('input-customer-type'), 'commercial');
    await user.type(screen.getByTestId('input-contact-name'), 'Bob Test');
    await user.type(screen.getByTestId('input-contact-email'), 'bob@testcorp.example');
    await user.type(screen.getByTestId('input-contact-phone'), '555-000-9999');
    await user.type(screen.getByTestId('input-job-site-name'), 'Test Site');
    await user.type(screen.getByTestId('input-job-site-address'), '1 Test Blvd');
    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('portal_submit_intake', {
        p_token:            VALID_TOKEN,
        p_customer_name:    'Test Corp',
        p_customer_type:    'commercial',
        p_contact_name:     'Bob Test',
        p_contact_email:    'bob@testcorp.example',
        p_contact_phone:    '555-000-9999',
        p_job_site_name:    'Test Site',
        p_job_site_address: '1 Test Blvd',
      });
    });
  });

  it('shows a submit error when the RPC fails', async () => {
    mockSubmitError('Intake token has expired');
    const user = userEvent.setup();
    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_WITH_TOKEN} />,
    );

    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toBeInTheDocument();
      expect(screen.getByText('Intake token has expired')).toBeInTheDocument();
    });
  });

  it('does not call the RPC when token is missing', async () => {
    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_NO_TOKEN} />,
    );

    // submit button is disabled; direct form submission attempt is blocked
    const submitButton = screen.getByTestId('submit-button');
    expect(submitButton).toBeDisabled();
    expect(rpcMock).not.toHaveBeenCalled();
  });

  it('scrubs the token from the address bar on mount', async () => {
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');
    // Simulate the browser having the full token fragment in the address bar.
    window.history.pushState(null, '', `#token=${VALID_TOKEN}`);

    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_WITH_TOKEN} />,
    );

    await waitFor(() => {
      const wasCalled = replaceStateSpy.mock.calls.some(
        ([, , url]) => typeof url === 'string' && !url.includes('token='),
      );
      expect(wasCalled).toBe(true);
    });

    replaceStateSpy.mockRestore();
  });

  it('preserves the initially captured token after the URL is scrubbed and the screen rerenders', async () => {
    const user = userEvent.setup();
    window.history.pushState(null, '', `/portal/intake/${TOKEN_ID}#token=${VALID_TOKEN}`);

    const { rerender } = render(
      <PortalIntakeScreen tokenId={TOKEN_ID} />,
    );

    await waitFor(() => {
      expect(window.location.href.includes('token=')).toBe(false);
    });

    rerender(<PortalIntakeScreen tokenId={TOKEN_ID} />);

    await user.type(screen.getByTestId('input-customer-name'), 'Acme Corp');
    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('portal_submit_intake', expect.objectContaining({
        p_token: VALID_TOKEN,
      }));
    });
  });

  it.each([
    'Intake token is required',
    'Intake token is invalid',
    'Intake token has been revoked',
    'Intake token has expired',
  ])('locks the form in a denied state after the RPC rejects a denied token: %s', async (message) => {
    mockSubmitError(message);
    const user = userEvent.setup();

    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_WITH_TOKEN} />,
    );

    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toBeInTheDocument();
      expect(screen.getByText('Invalid or expired link')).toBeInTheDocument();
      expect(screen.getByTestId('submit-button')).toBeDisabled();
    });
  });

  it('keeps the form retryable for non-token submission failures', async () => {
    mockSubmitError('Submission failed. Please try again.');
    const user = userEvent.setup();

    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_WITH_TOKEN} />,
    );

    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(screen.getByTestId('submit-error')).toBeInTheDocument();
      expect(screen.getByText('Submission failed')).toBeInTheDocument();
      expect(screen.getByTestId('submit-button')).not.toBeDisabled();
    });
  });

  it('passes null for empty optional fields to the RPC', async () => {
    const user = userEvent.setup();
    render(
      <PortalIntakeScreen tokenId={TOKEN_ID} pageUrl={PAGE_URL_WITH_TOKEN} />,
    );

    // Only fill in the customer name; leave everything else blank
    await user.type(screen.getByTestId('input-customer-name'), 'Minimal Corp');
    await user.click(screen.getByTestId('submit-button'));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith('portal_submit_intake', expect.objectContaining({
        p_customer_name:    'Minimal Corp',
        p_customer_type:    null,
        p_contact_name:     null,
        p_contact_email:    null,
        p_contact_phone:    null,
        p_job_site_name:    null,
        p_job_site_address: null,
      }));
    });
  });
});
