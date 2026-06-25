import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpcMock, fromMock } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock('@tanstack/react-router', async () => {
  const actual = await vi.importActual<typeof import('@tanstack/react-router')>('@tanstack/react-router');
  return {
    ...actual,
    createFileRoute: () => () => ({}),
  };
});

vi.mock('@/data/supabase', () => ({
  supabase: {
    rpc: rpcMock,
    from: fromMock,
  },
}));

import { InventoryKitsScreen } from '@/routes/inventory/kits';

function mockFrom() {
  fromMock.mockImplementation((table: string) => {
    const filters: Record<string, unknown> = {};

    const query = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn((column: string, value: unknown) => {
        filters[column] = value;
        return query;
      }),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockImplementation(() => {
        if (table === 'entities') {
          const entityType = filters.entity_type;
          if (entityType === 'asset_category') {
            return Promise.resolve({
              data: [{ id: 'cat-001', entity_versions: [{ data: { name: 'Earthmoving' } }] }],
              error: null,
            });
          }
          if (entityType === 'asset') {
            return Promise.resolve({
              data: [{ id: 'asset-001', entity_versions: [{ data: { name: 'CAT 320' } }] }],
              error: null,
            });
          }
          if (entityType === 'stock_item') {
            return Promise.resolve({
              data: [{ id: 'stock-001', entity_versions: [{ data: { name: 'Hydraulic Oil' } }] }],
              error: null,
            });
          }
          return Promise.resolve({ data: [], error: null });
        }

        if (table === 'rental_current_inventory_kits') {
          return Promise.resolve({ data: [], error: null });
        }

        return Promise.resolve({ data: [], error: null });
      }),
    };

    return query;
  });
}

describe('InventoryKitsScreen', () => {
  beforeEach(() => {
    rpcMock.mockReset();
    fromMock.mockReset();
    mockFrom();
    rpcMock.mockResolvedValue({
      data: [{ kit_id: 'kit-001', entity_version_id: 'ev-001', version_number: 1 }],
      error: null,
    });
  });

  it('renders the kits admin screen', async () => {
    render(<InventoryKitsScreen />);
    expect(screen.getByRole('heading', { name: 'Inventory Kits & Bundles' })).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByTestId('kits-empty-state')).toBeInTheDocument();
    });
  });

  it('preserves loaded component option label when entity is absent from bootstrapped list', async () => {
    const user = userEvent.setup();

    fromMock.mockImplementation((table: string) => {
      const filters: Record<string, unknown> = {};

      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((column: string, value: unknown) => {
          filters[column] = value;
          if (table === 'rental_inventory_kit_components_current') {
            return Promise.resolve({
              data: [
                {
                  component_entity_type: 'asset_category',
                  component_id: 'cat-absent-999',
                  component_label: 'Absent Category',
                  quantity: 2,
                  is_required: true,
                  is_default: false,
                  effective_from: null,
                  effective_to: null,
                },
              ],
              error: null,
            });
          }
          return query;
        }),
        order: vi.fn().mockImplementation(() => {
          if (table === 'rental_current_inventory_kits') {
            return Promise.resolve({
              data: [{ entity_id: 'kit-001', name: 'Earthmoving Bundle', description: null, effective_from: null, effective_to: null }],
              error: null,
            });
          }
          return query;
        }),
        limit: vi.fn().mockImplementation(() => {
          if (table === 'entities') {
            if (filters.entity_type === 'asset_category') {
              return Promise.resolve({
                data: [{ id: 'cat-001', entity_versions: [{ data: { name: 'Earthmoving' } }] }],
                error: null,
              });
            }
            if (filters.entity_type === 'asset') {
              return Promise.resolve({
                data: [{ id: 'asset-001', entity_versions: [{ data: { name: 'CAT 320' } }] }],
                error: null,
              });
            }
            if (filters.entity_type === 'stock_item') {
              return Promise.resolve({
                data: [{ id: 'stock-001', entity_versions: [{ data: { name: 'Hydraulic Oil' } }] }],
                error: null,
              });
            }
            return Promise.resolve({ data: [], error: null });
          }
          if (table === 'rental_current_inventory_kits') {
            return Promise.resolve({
              data: [
                {
                  entity_id: 'kit-001',
                  name: 'Earthmoving Bundle',
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

    render(<InventoryKitsScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('kit-row-kit-001')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('kit-row-kit-001'));

    await waitFor(() => {
      expect(screen.getByTestId('input-kit-component-id-0')).toHaveValue('cat-absent-999');
    });

    const componentSelect = screen.getByTestId('input-kit-component-id-0');
    expect(componentSelect).toHaveValue('cat-absent-999');
    expect(screen.getByRole('option', { name: 'Absent Category' })).toBeInTheDocument();
  });

  it('falls back to truncated UUID label when component name is empty and entity is absent from bootstrapped list', async () => {
    const user = userEvent.setup();

    fromMock.mockImplementation((table: string) => {
      const filters: Record<string, unknown> = {};

      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((column: string, value: unknown) => {
          filters[column] = value;
          if (table === 'rental_inventory_kit_components_current') {
            return Promise.resolve({
              data: [
                {
                  component_entity_type: 'asset_category',
                  component_id: 'abcdef12-0000-0000-0000-000000000000',
                  component_label: '',
                  quantity: 1,
                  is_required: true,
                  is_default: false,
                  effective_from: null,
                  effective_to: null,
                },
              ],
              error: null,
            });
          }
          return query;
        }),
        order: vi.fn().mockImplementation(() => {
          if (table === 'rental_current_inventory_kits') {
            return Promise.resolve({
              data: [{ entity_id: 'kit-002', name: 'Unnamed Bundle', description: null, effective_from: null, effective_to: null }],
              error: null,
            });
          }
          return query;
        }),
        limit: vi.fn().mockImplementation(() => {
          if (table === 'entities') {
            if (filters.entity_type === 'asset_category') {
              return Promise.resolve({
                data: [{ id: 'cat-001', entity_versions: [{ data: { name: 'Earthmoving' } }] }],
                error: null,
              });
            }
            return Promise.resolve({ data: [], error: null });
          }
          if (table === 'rental_current_inventory_kits') {
            return Promise.resolve({
              data: [
                {
                  entity_id: 'kit-002',
                  name: 'Unnamed Bundle',
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

    render(<InventoryKitsScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('kit-row-kit-002')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('kit-row-kit-002'));

    await waitFor(() => {
      expect(screen.getByTestId('input-kit-component-id-0')).toHaveValue('abcdef12-0000-0000-0000-000000000000');
    });

    const componentSelect = screen.getByTestId('input-kit-component-id-0');
    expect(componentSelect).toHaveValue('abcdef12-0000-0000-0000-000000000000');
    expect(screen.getByRole('option', { name: 'abcdef12' })).toBeInTheDocument();
  });

  it('submits kit definition with component metadata', async () => {
    const user = userEvent.setup();
    render(<InventoryKitsScreen />);

    await user.type(screen.getByTestId('input-kit-name'), 'Weekend Earthmoving Bundle');
    await user.type(screen.getByTestId('input-kit-description'), 'Excavator + accessory stock kit');

    await user.selectOptions(screen.getByTestId('input-kit-component-type-0'), 'asset_category');
    await user.selectOptions(screen.getByTestId('input-kit-component-id-0'), 'cat-001');
    await user.clear(screen.getByTestId('input-kit-component-quantity-0'));
    await user.type(screen.getByTestId('input-kit-component-quantity-0'), '2');

    await user.click(screen.getByTestId('btn-save-kit'));

    await waitFor(() => {
      expect(rpcMock).toHaveBeenCalledWith(
        'staff_upsert_inventory_kit',
        expect.objectContaining({
          p_name: 'Weekend Earthmoving Bundle',
          p_description: 'Excavator + accessory stock kit',
          p_components: [
            expect.objectContaining({
              component_type: 'asset_category',
              component_id: 'cat-001',
              component_name: 'Earthmoving',
              quantity: 2,
              is_required: true,
            }),
          ],
        }),
      );
    });

    expect(screen.getByTestId('kits-save-success')).toHaveTextContent('Saved kit Weekend Earthmoving Bundle');
  });

  it('shows an operator-friendly load error without leaking schema identifiers', async () => {
    fromMock.mockImplementation((table: string) => {
      const filters: Record<string, unknown> = {};

      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((column: string, value: unknown) => {
          filters[column] = value;
          return query;
        }),
        order: vi.fn().mockImplementation(() => {
          if (table === 'rental_current_inventory_kits') {
            return Promise.resolve({
              data: null,
              error: {
                message: "Could not find the table 'public.rental_current_inventory_kits' in the schema cache",
              },
            });
          }
          return query;
        }),
        limit: vi.fn().mockImplementation(() => {
          if (table === 'entities') {
            if (filters.entity_type === 'asset_category') {
              return Promise.resolve({
                data: [{ id: 'cat-001', entity_versions: [{ data: { name: 'Earthmoving' } }] }],
                error: null,
              });
            }
            if (filters.entity_type === 'asset') {
              return Promise.resolve({
                data: [{ id: 'asset-001', entity_versions: [{ data: { name: 'CAT 320' } }] }],
                error: null,
              });
            }
            if (filters.entity_type === 'stock_item') {
              return Promise.resolve({
                data: [{ id: 'stock-001', entity_versions: [{ data: { name: 'Hydraulic Oil' } }] }],
                error: null,
              });
            }
          }
          return Promise.resolve({ data: [], error: null });
        }),
      };

      return query;
    });

    render(<InventoryKitsScreen />);

    const banner = await screen.findByTestId('kits-load-error');
    expect(banner).toHaveTextContent('Kit catalog is temporarily unavailable');
    expect(banner).toHaveTextContent('please try again or contact support');
    expect(banner).not.toHaveTextContent('public.');
    expect(banner).not.toHaveTextContent('schema cache');
  });

  it('shows an actionable save error without leaking schema identifiers', async () => {
    const user = userEvent.setup();
    rpcMock.mockResolvedValue({
      data: null,
      error: {
        message:
          'Could not find the function public.staff_upsert_inventory_kit(p_components, p_description, p_effective_from, p_effective_to, p_kit_id, p_name, p_pricing_override, p_rate_plan_id) in the schema cache',
      },
    });

    render(<InventoryKitsScreen />);

    await user.type(screen.getByTestId('input-kit-name'), 'Weekend Earthmoving Bundle');
    await user.selectOptions(screen.getByTestId('input-kit-component-type-0'), 'asset_category');
    await user.selectOptions(screen.getByTestId('input-kit-component-id-0'), 'cat-001');
    await user.click(screen.getByTestId('btn-save-kit'));

    const banner = await screen.findByTestId('kits-save-error');
    expect(banner).toHaveTextContent('We could not save this kit right now.');
    expect(banner).toHaveTextContent('Please try again.');
    expect(banner).toHaveTextContent('verify the latest inventory kit migration is deployed');
    expect(banner).not.toHaveTextContent('public.');
    expect(banner).not.toHaveTextContent('schema cache');
  });

  it('associates visible labels with component authoring controls', async () => {
    render(<InventoryKitsScreen />);

    expect(screen.getByLabelText('Type')).toBeInTheDocument();
    expect(screen.getByLabelText('Component')).toBeInTheDocument();
    expect(screen.getByLabelText('Name override')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity')).toBeInTheDocument();
    expect(screen.getByLabelText('Required')).toBeInTheDocument();
    expect(screen.getByLabelText('Default')).toBeInTheDocument();
    expect(screen.getByLabelText('Effective From', { selector: '[data-testid="input-kit-component-effective-from-0"]' })).toBeInTheDocument();
    expect(screen.getByLabelText('Effective To', { selector: '[data-testid="input-kit-component-effective-to-0"]' })).toBeInTheDocument();
  });

  it('normalizes fractional quantities and restores component context when reopening an existing kit', async () => {
    const user = userEvent.setup();

    fromMock.mockImplementation((table: string) => {
      const filters: Record<string, unknown> = {};

      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((column: string, value: unknown) => {
          filters[column] = value;
          if (table === 'rental_inventory_kit_components_current') {
            return Promise.resolve({
              data: [
                {
                  component_entity_type: 'asset',
                  component_id: 'asset-007',
                  component_label: 'CAT 320 Excavator',
                  quantity: 2.9,
                  is_required: false,
                  is_default: true,
                  effective_from: '2026-01-01',
                  effective_to: '2026-12-31',
                },
              ],
              error: null,
            });
          }
          return query;
        }),
        order: vi.fn().mockImplementation(() => {
          if (table === 'rental_current_inventory_kits') {
            return Promise.resolve({
              data: [{ entity_id: 'kit-context', name: 'Context Test Kit', description: 'test desc', effective_from: null, effective_to: null }],
              error: null,
            });
          }
          return query;
        }),
        limit: vi.fn().mockImplementation(() => {
          if (table === 'entities') {
            if (filters.entity_type === 'asset_category') {
              return Promise.resolve({
                data: [{ id: 'cat-001', entity_versions: [{ data: { name: 'Earthmoving' } }] }],
                error: null,
              });
            }
            if (filters.entity_type === 'asset') {
              return Promise.resolve({
                data: [{ id: 'asset-007', entity_versions: [{ data: { name: 'CAT 320 Excavator' } }] }],
                error: null,
              });
            }
            if (filters.entity_type === 'stock_item') {
              return Promise.resolve({
                data: [{ id: 'stock-001', entity_versions: [{ data: { name: 'Hydraulic Oil' } }] }],
                error: null,
              });
            }
            return Promise.resolve({ data: [], error: null });
          }
          if (table === 'rental_current_inventory_kits') {
            return Promise.resolve({
              data: [
                {
                  entity_id: 'kit-context',
                  name: 'Context Test Kit',
                  description: 'test desc',
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

    render(<InventoryKitsScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('kit-row-kit-context')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('kit-row-kit-context'));

    await waitFor(() => {
      expect(screen.getByTestId('input-kit-component-id-0')).toHaveValue('asset-007');
    });

    expect(screen.getByTestId('input-kit-component-type-0')).toHaveValue('asset');
    expect(screen.getByTestId('input-kit-component-name-0')).toHaveValue('CAT 320 Excavator');
    // The edit form is integer-only, so handleEdit() rounds persisted numeric quantities for display.
    expect(screen.getByTestId('input-kit-component-quantity-0')).toHaveValue(3);
    expect(screen.getByTestId('input-kit-component-required-0')).not.toBeChecked();
    expect(screen.getByTestId('input-kit-component-default-0')).toBeChecked();
    expect(screen.getByTestId('input-kit-component-effective-from-0')).toHaveValue('2026-01-01');
    expect(screen.getByTestId('input-kit-component-effective-to-0')).toHaveValue('2026-12-31');
  });

  it('clamps microscopic component quantities back to 1 for the edit form', async () => {
    const user = userEvent.setup();

    fromMock.mockImplementation((table: string) => {
      const filters: Record<string, unknown> = {};

      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((column: string, value: unknown) => {
          filters[column] = value;
          if (table === 'rental_inventory_kit_components_current') {
            return Promise.resolve({
              data: [
                {
                  component_entity_type: 'asset_category',
                  component_id: 'cat-001',
                  component_label: 'Earthmoving',
                  quantity: 0.000001,
                  is_required: true,
                  is_default: false,
                  effective_from: null,
                  effective_to: null,
                },
              ],
              error: null,
            });
          }
          return query;
        }),
        order: vi.fn().mockImplementation(() => {
          if (table === 'rental_current_inventory_kits') {
            return Promise.resolve({
              data: [{ entity_id: 'kit-clamp', name: 'Clamp Test Kit', description: null, effective_from: null, effective_to: null }],
              error: null,
            });
          }
          return query;
        }),
        limit: vi.fn().mockImplementation(() => {
          if (table === 'entities') {
            if (filters.entity_type === 'asset_category') {
              return Promise.resolve({
                data: [{ id: 'cat-001', entity_versions: [{ data: { name: 'Earthmoving' } }] }],
                error: null,
              });
            }
            if (filters.entity_type === 'asset') {
              return Promise.resolve({
                data: [{ id: 'asset-001', entity_versions: [{ data: { name: 'CAT 320' } }] }],
                error: null,
              });
            }
            if (filters.entity_type === 'stock_item') {
              return Promise.resolve({
                data: [{ id: 'stock-001', entity_versions: [{ data: { name: 'Hydraulic Oil' } }] }],
                error: null,
              });
            }
            return Promise.resolve({ data: [], error: null });
          }
          if (table === 'rental_current_inventory_kits') {
            return Promise.resolve({
              data: [
                {
                  entity_id: 'kit-clamp',
                  name: 'Clamp Test Kit',
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

    render(<InventoryKitsScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('kit-row-kit-clamp')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('kit-row-kit-clamp'));

    await waitFor(() => {
      expect(screen.getByTestId('input-kit-component-quantity-0')).toHaveValue(1);
    });
  });

  it('auto-restores kit edit context from initialKitId after bootstrap loads', async () => {
    fromMock.mockImplementation((table: string) => {
      const filters: Record<string, unknown> = {};

      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((column: string, value: unknown) => {
          filters[column] = value;
          if (table === 'rental_inventory_kit_components_current') {
            return Promise.resolve({
              data: [
                {
                  component_entity_type: 'asset_category',
                  component_id: 'cat-001',
                  component_label: 'Earthmoving',
                  quantity: 1,
                  is_required: true,
                  is_default: false,
                  effective_from: null,
                  effective_to: null,
                },
              ],
              error: null,
            });
          }
          return query;
        }),
        order: vi.fn().mockImplementation(() => {
          if (table === 'rental_current_inventory_kits') {
            return Promise.resolve({
              data: [{ entity_id: 'kit-restore', name: 'Restore Test Kit', description: null, effective_from: null, effective_to: null }],
              error: null,
            });
          }
          return query;
        }),
        limit: vi.fn().mockImplementation(() => {
          if (table === 'entities') {
            if (filters.entity_type === 'asset_category') {
              return Promise.resolve({
                data: [{ id: 'cat-001', entity_versions: [{ data: { name: 'Earthmoving' } }] }],
                error: null,
              });
            }
            return Promise.resolve({ data: [], error: null });
          }
          if (table === 'rental_current_inventory_kits') {
            return Promise.resolve({
              data: [
                {
                  entity_id: 'kit-restore',
                  name: 'Restore Test Kit',
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

    render(<InventoryKitsScreen initialKitId="kit-restore" />);

    await waitFor(() => {
      expect(screen.getByTestId('input-kit-name')).toHaveValue('Restore Test Kit');
    });

    expect(screen.getByRole('heading', { name: 'Edit kit' })).toBeInTheDocument();
    expect(screen.getByTestId('input-kit-component-id-0')).toHaveValue('cat-001');
  });

  it('shows an operator-readable not-found error when initialKitId kit is absent', async () => {
    fromMock.mockImplementation((table: string) => {
      const query = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn(() => {
          if (table === 'rental_inventory_kit_components_current') {
            return Promise.resolve({ data: [], error: null });
          }
          return query;
        }),
        order: vi.fn().mockImplementation(() => {
          if (table === 'rental_current_inventory_kits') {
            return Promise.resolve({ data: [], error: null });
          }
          return query;
        }),
        limit: vi.fn().mockImplementation(() => {
          return Promise.resolve({ data: [], error: null });
        }),
      };
      return query;
    });

    render(<InventoryKitsScreen initialKitId="nonexistent-kit-id" />);

    const banner = await screen.findByTestId('kits-not-found-error');
    expect(banner).toHaveTextContent('Kit not found');
    expect(banner).toHaveTextContent('may have been deleted');
  });

  it('calls onKitIdChange with kit id when a kit is selected for editing', async () => {
    const user = userEvent.setup();
    const onKitIdChange = vi.fn();

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
              data: [{ entity_id: 'kit-cb', name: 'Callback Kit', description: null, effective_from: null, effective_to: null }],
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
                  entity_id: 'kit-cb',
                  name: 'Callback Kit',
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

    render(<InventoryKitsScreen onKitIdChange={onKitIdChange} />);

    await waitFor(() => {
      expect(screen.getByTestId('kit-row-kit-cb')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('kit-row-kit-cb'));

    await waitFor(() => {
      expect(onKitIdChange).toHaveBeenCalledWith('kit-cb');
    });
  });

  it('calls onKitIdChange with null when New Draft is clicked', async () => {
    const user = userEvent.setup();
    const onKitIdChange = vi.fn();

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
              data: [{ entity_id: 'kit-draft', name: 'Draft Kit', description: null, effective_from: null, effective_to: null }],
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
                  entity_id: 'kit-draft',
                  name: 'Draft Kit',
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

    render(<InventoryKitsScreen onKitIdChange={onKitIdChange} />);

    await waitFor(() => {
      expect(screen.getByTestId('kit-row-kit-draft')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('kit-row-kit-draft'));

    await waitFor(() => {
      expect(onKitIdChange).toHaveBeenCalledWith('kit-draft');
    });

    onKitIdChange.mockClear();
    await user.click(screen.getByTestId('btn-reset-kit-form'));

    expect(onKitIdChange).toHaveBeenCalledWith(null);
  });

  it('calls onKitIdChange with new kit id after a successful save', async () => {
    const user = userEvent.setup();
    const onKitIdChange = vi.fn();

    rpcMock.mockResolvedValue({
      data: [{ kit_id: 'kit-saved-new', entity_version_id: 'ev-002', version_number: 1 }],
      error: null,
    });

    render(<InventoryKitsScreen onKitIdChange={onKitIdChange} />);

    await user.type(screen.getByTestId('input-kit-name'), 'New Save Kit');
    await user.selectOptions(screen.getByTestId('input-kit-component-type-0'), 'asset_category');
    await user.selectOptions(screen.getByTestId('input-kit-component-id-0'), 'cat-001');

    await user.click(screen.getByTestId('btn-save-kit'));

    await waitFor(() => {
      expect(onKitIdChange).toHaveBeenCalledWith('kit-saved-new');
    });
  });
});
