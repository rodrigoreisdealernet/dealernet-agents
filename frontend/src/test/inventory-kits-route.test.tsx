/**
 * Route-level contract tests for the inventory kits route.
 *
 * These tests exercise InventoryKitsPage (the router wrapper) directly, proving
 * both sides of the URL-persistence feature:
 *  1. validateSearch correctly round-trips kit_id.
 *  2. Mounting with kit_id in route search auto-rehydrates the kit detail without
 *     the user clicking any row.
 *  3. Clicking a kit row writes kit_id back into the route search via navigate.
 *  4. Clicking "New Draft" clears kit_id from the route search.
 *
 * If the route wrapper, validateSearch, or useNavigate wiring were removed or
 * broken these tests would fail, unlike the props-based tests in
 * inventory-kits.test.tsx which only exercise InventoryKitsScreen in isolation.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpcMock, fromMock, navigateSpy } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
  navigateSpy: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

vi.mock('@/data/supabase', () => ({
  supabase: {
    rpc: rpcMock,
    from: fromMock,
  },
}));

import { InventoryKitsPage, Route } from '@/routes/inventory/kits';

function mockSupabaseWithKit(kitId: string, kitName: string) {
  fromMock.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};

    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn((column: string, value: unknown) => {
        filters[column] = value;
        if (table === 'rental_inventory_kit_components_current') {
          return Promise.resolve({ data: [], error: null });
        }
        return query;
      }),
      order: vi.fn().mockImplementation(() => {
        if (table === 'rental_current_inventory_kits') {
          return Promise.resolve({
            data: [{ entity_id: kitId, name: kitName, description: null, effective_from: null, effective_to: null }],
            error: null,
          });
        }
        return query;
      }),
      limit: vi.fn().mockImplementation(() => {
        if (table === 'entities') {
          return Promise.resolve({ data: [], error: null });
        }
        if (table === 'rental_current_inventory_kits') {
          return Promise.resolve({
            data: [
              {
                entity_id: kitId,
                name: kitName,
                description: null,
                effective_from: null,
                effective_to: null,
                rate_plan_id: null,
                pricing_override: {},
              },
            ],
            error: null,
          });
        }
        return Promise.resolve({ data: [], error: null });
      }),
    };

    return query;
  });
}

describe('InventoryKitsPage route contract', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    navigateSpy.mockReset();
  });

  describe('validateSearch', () => {
    const validateSearch = Route.options.validateSearch as (search: Record<string, unknown>) => { kit_id: string | undefined };

    it('round-trips a valid kit_id string', () => {
      expect(validateSearch({ kit_id: 'kit-abc-123' })).toEqual({ kit_id: 'kit-abc-123' });
    });

    it('returns undefined kit_id when param is absent', () => {
      expect(validateSearch({})).toEqual({ kit_id: undefined });
    });

    it('returns undefined kit_id when param is not a string', () => {
      expect(validateSearch({ kit_id: 42 })).toEqual({ kit_id: undefined });
    });
  });

  it('auto-rehydrates kit detail when mounted with kit_id in route search', async () => {
    mockSupabaseWithKit('kit-route-restore', 'Route Restore Kit');

    const useSearchSpy = vi.spyOn(Route, 'useSearch').mockReturnValue({ kit_id: 'kit-route-restore' });

    render(<InventoryKitsPage />);

    await waitFor(() => {
      expect(screen.getByTestId('input-kit-name')).toHaveValue('Route Restore Kit');
    });

    expect(screen.getByRole('heading', { name: 'Edit kit' })).toBeInTheDocument();
    expect(navigateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ search: { kit_id: 'kit-route-restore' }, replace: true }),
    );

    useSearchSpy.mockRestore();
  });

  it('writes kit_id to route search when a kit row is clicked', async () => {
    const user = userEvent.setup();
    mockSupabaseWithKit('kit-route-click', 'Click Kit');

    const useSearchSpy = vi.spyOn(Route, 'useSearch').mockReturnValue({ kit_id: undefined });

    render(<InventoryKitsPage />);

    await waitFor(() => {
      expect(screen.getByTestId('kit-row-kit-route-click')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('kit-row-kit-route-click'));

    await waitFor(() => {
      expect(navigateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ search: { kit_id: 'kit-route-click' }, replace: true }),
      );
    });

    useSearchSpy.mockRestore();
  });

  it('clears kit_id from route search when New Draft is clicked', async () => {
    const user = userEvent.setup();
    mockSupabaseWithKit('kit-route-reset', 'Reset Kit');

    const useSearchSpy = vi.spyOn(Route, 'useSearch').mockReturnValue({ kit_id: 'kit-route-reset' });

    render(<InventoryKitsPage />);

    await waitFor(() => {
      expect(screen.getByTestId('input-kit-name')).toHaveValue('Reset Kit');
    });

    navigateSpy.mockClear();
    await user.click(screen.getByTestId('btn-reset-kit-form'));

    expect(navigateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ search: {}, replace: true }),
    );

    useSearchSpy.mockRestore();
  });
});
