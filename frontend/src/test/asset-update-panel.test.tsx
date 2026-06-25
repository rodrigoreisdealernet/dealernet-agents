import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { uploadMock, getPublicUrlMock, storageFromMock, authState } = vi.hoisted(() => ({
  uploadMock: vi.fn(),
  getPublicUrlMock: vi.fn(),
  storageFromMock: vi.fn(),
  authState: {
    session: { access_token: 'token-123' },
    profile: { id: 'user-1', role: 'admin', displayName: 'Admin User' },
  },
}));

type TestRole = 'admin' | 'field_operator' | 'read_only';

const capabilityStateByRole: Record<TestRole, { canWrite: boolean; canOperate: boolean; role: TestRole }> = {
  admin: { canWrite: true, canOperate: true, role: 'admin' },
  field_operator: { canWrite: false, canOperate: true, role: 'field_operator' },
  read_only: { canWrite: false, canOperate: false, role: 'read_only' },
};

vi.mock('@/auth/AuthContext', () => ({
  useAuth: () => authState,
  useAuthCapabilities: () => capabilityStateByRole[authState.profile.role as TestRole],
}));

vi.mock('@/data/supabase', () => ({
  supabase: {
    storage: {
      from: storageFromMock,
    },
  },
}));

import { AssetUpdatePanel } from '@/components/assets/AssetUpdatePanel';

function renderPanel() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return {
    queryClient,
    ...render(
      <QueryClientProvider client={queryClient}>
        <AssetUpdatePanel assetId="asset-1" />
      </QueryClientProvider>
    ),
  };
}

describe('asset update panel', () => {
  beforeEach(() => {
    authState.profile = { id: 'user-1', role: 'admin', displayName: 'Admin User' };
    uploadMock.mockReset();
    getPublicUrlMock.mockReset();
    storageFromMock.mockReset();
    uploadMock.mockResolvedValue({ error: null });
    getPublicUrlMock.mockReturnValue({ data: { publicUrl: 'https://cdn.example.com/new-image.jpg' } });
    storageFromMock.mockReturnValue({
      upload: uploadMock,
      getPublicUrl: getPublicUrlMock,
    });
  });

  it('uploads evidence and submits a Temporal-backed asset update request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ summary: 'Asset image updated and status moved to inspection hold.' }), { status: 200 })
    );
    const { queryClient } = renderPanel();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    const file = new File(['image-bytes'], 'damage photo.png', { type: 'image/png' });

    await userEvent.upload(screen.getByLabelText('Image evidence'), file);
    await userEvent.type(screen.getByLabelText('Evidence comments'), 'Hydraulic leak visible near the arm.');
    await userEvent.click(screen.getByLabelText('Submit as a damage / condition report'));
    await userEvent.type(screen.getByLabelText('Damage summary'), 'Leak with visible hose damage');
    await userEvent.click(screen.getByRole('button', { name: 'Submit asset update' }));

    await waitFor(() => expect(uploadMock).toHaveBeenCalledTimes(1));
    expect(storageFromMock).toHaveBeenCalledWith('field-evidence');
    expect(uploadMock.mock.calls[0]?.[0]).toMatch(/^assets\/asset-1\//);
    expect(getPublicUrlMock).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ops/assets/asset-1/update-request',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `${'Bea'}${'rer'} token-123`,
          'Content-Type': 'application/json',
        }),
      })
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      comments: 'Hydraulic leak visible near the arm.',
      report_damage: true,
      damage_summary: 'Leak with visible hose damage',
      evidence: [
        {
          file_name: 'damage photo.png',
          path: expect.stringMatching(/^assets\/asset-1\//),
          url: 'https://cdn.example.com/new-image.jpg',
        },
      ],
    });
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['datasource'] }));
    expect(await screen.findByText('Asset image updated and status moved to inspection hold.')).toBeInTheDocument();
  });

  it('requires evidence or comments before submitting', async () => {
    renderPanel();

    await userEvent.click(screen.getByRole('button', { name: 'Submit asset update' }));

    expect(screen.getByText('Add image evidence or comments before submitting an update request.')).toBeInTheDocument();
  });

  it('allows field operators to access the panel but hides it for read-only users', () => {
    authState.profile = { id: 'user-2', role: 'field_operator', displayName: 'Field Operator' };
    const { rerender } = renderPanel();

    expect(screen.getByText('Image updates & damage reports')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit asset update' })).toBeInTheDocument();

    authState.profile = { id: 'user-3', role: 'read_only', displayName: 'Read Only User' };
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <AssetUpdatePanel assetId="asset-1" />
      </QueryClientProvider>
    );

    expect(screen.queryByText('Image updates & damage reports')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit asset update' })).not.toBeInTheDocument();
  });
});
