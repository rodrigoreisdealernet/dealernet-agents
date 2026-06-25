import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { AlertCircle, Loader2, Plus, Save } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/data/supabase';

export const Route = createFileRoute('/inventory/kits')({
  validateSearch: (search: Record<string, unknown>) => ({
    kit_id: typeof search.kit_id === 'string' ? search.kit_id : undefined,
  }),
  component: InventoryKitsPage,
});

type KitComponentType = 'asset' | 'asset_category' | 'stock_item';

type LookupOption = { id: string; label: string };

type KitComponentDraft = {
  componentType: KitComponentType;
  componentId: string;
  componentName: string;
  quantity: string;
  isRequired: boolean;
  isDefault: boolean;
  effectiveFrom: string;
  effectiveTo: string;
};

type KitSummary = {
  entity_id: string;
  name: string;
  description: string | null;
  effective_from: string | null;
  effective_to: string | null;
};

const KIT_LOAD_ERROR_MESSAGE = 'Kit catalog is temporarily unavailable — please try again or contact support.';
const KIT_SAVE_ERROR_MESSAGE =
  'We could not save this kit right now. Please try again. If the problem continues, contact support and ask them to verify the latest inventory kit migration is deployed.';
const KIT_EDIT_ERROR_MESSAGE = 'Could not load the selected kit. Please try again or contact support.';
const KIT_NOT_FOUND_ERROR_MESSAGE =
  'The kit you were editing could not be found. It may have been deleted — please select a kit from the list or create a new one.';

function formatErrorDetail(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' && error.message.trim().length > 0) {
    return error.message;
  }
  return 'unknown error';
}

const emptyComponent = (): KitComponentDraft => ({
  componentType: 'asset_category',
  componentId: '',
  componentName: '',
  quantity: '1',
  isRequired: true,
  isDefault: false,
  effectiveFrom: '',
  effectiveTo: '',
});

function lookupLabelFromCurrentData(row: { id: string; entity_versions?: Array<{ data?: Record<string, unknown> }> }): string {
  const data = row.entity_versions?.[0]?.data ?? {};
  const candidates = [data.name, data.asset_tag, data.serial_number, data.code, data.identifier]
    .filter((value) => typeof value === 'string' && value.trim().length > 0) as string[];
  return candidates[0] ?? row.id.slice(0, 8);
}

async function loadEntityOptions(entityType: string): Promise<LookupOption[]> {
  const { data, error } = await supabase
    .from('entities')
    .select('id, entity_versions!inner(data)')
    .eq('entity_type', entityType)
    .eq('entity_versions.is_current', true)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) return [];

  const rows = (data ?? []) as Array<{ id: string; entity_versions?: Array<{ data?: Record<string, unknown> }> }>;
  return rows.map((row) => ({ id: row.id, label: lookupLabelFromCurrentData(row) }));
}

interface InventoryKitsScreenProps {
  initialKitId?: string;
  onKitIdChange?: (id: string | null) => void;
}

export function InventoryKitsScreen({ initialKitId, onKitIdChange }: InventoryKitsScreenProps = {}) {
  const [kits, setKits] = useState<KitSummary[]>([]);
  const [assetOptions, setAssetOptions] = useState<LookupOption[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<LookupOption[]>([]);
  const [stockOptions, setStockOptions] = useState<LookupOption[]>([]);

  const [kitId, setKitId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [effectiveTo, setEffectiveTo] = useState('');
  const [ratePlanId, setRatePlanId] = useState('');
  const [pricingOverrideJson, setPricingOverrideJson] = useState('{}');
  const [components, setComponents] = useState<KitComponentDraft[]>([emptyComponent()]);

  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [notFoundError, setNotFoundError] = useState<string | null>(null);

  // initialKitIdRef is intentionally read-only after mount: bootstrap captures it once
  // to auto-restore the kit edit context on initial load and never re-runs for URL changes.
  const initialKitIdRef = useRef(initialKitId);
  const onKitIdChangeRef = useRef(onKitIdChange);
  onKitIdChangeRef.current = onKitIdChange;

  const componentOptionsByType = useMemo(
    () => ({
      asset: assetOptions,
      asset_category: categoryOptions,
      stock_item: stockOptions,
    }),
    [assetOptions, categoryOptions, stockOptions],
  );

  const loadKits = useCallback(async () => {
    const { data, error } = await supabase
      .from('rental_current_inventory_kits')
      .select('entity_id, name, description, effective_from, effective_to')
      .order('created_at', { ascending: false });

    if (error) {
      console.error(`Inventory kits load failed: ${formatErrorDetail(error)}`);
      setLoadError(KIT_LOAD_ERROR_MESSAGE);
      return;
    }

    setLoadError(null);
    setKits((data ?? []) as KitSummary[]);
  }, []);

  const handleEdit = useCallback(async (targetKitId: string) => {
    setBusy(true);
    setSaveError(null);
    setSavedMessage(null);
    setNotFoundError(null);

    try {
      const [{ data: kitRows, error: kitError }, { data: compRows, error: compError }] = await Promise.all([
        supabase
          .from('rental_current_inventory_kits')
          .select('entity_id, name, description, effective_from, effective_to, rate_plan_id, pricing_override')
          .eq('entity_id', targetKitId)
          .limit(1),
        supabase
          .from('rental_inventory_kit_components_current')
          .select('component_entity_type, component_id, component_label, quantity, is_required, is_default, effective_from, effective_to')
          .eq('kit_id', targetKitId),
      ]);

      if (kitError) throw kitError;
      if (compError) throw compError;

      const kit = (kitRows ?? [])[0] as Record<string, unknown> | undefined;
      if (!kit) {
        setNotFoundError(KIT_NOT_FOUND_ERROR_MESSAGE);
        onKitIdChangeRef.current?.(null);
        return;
      }

      setKitId(String(kit.entity_id));
      setName(String(kit.name ?? ''));
      setDescription(String(kit.description ?? ''));
      setEffectiveFrom(String(kit.effective_from ?? ''));
      setEffectiveTo(String(kit.effective_to ?? ''));
      setRatePlanId(String(kit.rate_plan_id ?? ''));
      setPricingOverrideJson(JSON.stringify(kit.pricing_override ?? {}, null, 2));

      const mapped = (compRows ?? []).map((row) => {
        const comp = row as Record<string, unknown>;
        return {
          componentType: (String(comp.component_entity_type ?? 'asset_category') as KitComponentType),
          componentId: String(comp.component_id ?? ''),
          componentName: String(comp.component_label ?? ''),
          quantity: String(Math.max(1, Math.round(Number(comp.quantity ?? 1)))),
          isRequired: Boolean(comp.is_required ?? true),
          isDefault: Boolean(comp.is_default ?? false),
          effectiveFrom: String(comp.effective_from ?? ''),
          effectiveTo: String(comp.effective_to ?? ''),
        } satisfies KitComponentDraft;
      });

      setComponents(mapped.length > 0 ? mapped : [emptyComponent()]);
      onKitIdChangeRef.current?.(targetKitId);
    } catch (error) {
      console.error(`Inventory kit edit load failed: ${formatErrorDetail(error)}`);
      setSaveError(KIT_EDIT_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const [assets, categories, stockItems] = await Promise.all([
        loadEntityOptions('asset'),
        loadEntityOptions('asset_category'),
        loadEntityOptions('stock_item'),
      ]);

      if (cancelled) return;
      setAssetOptions(assets);
      setCategoryOptions(categories);
      setStockOptions(stockItems);
      await loadKits();

      const savedKitId = initialKitIdRef.current;
      if (savedKitId && !cancelled) {
        await handleEdit(savedKitId);
      }
    }

    void bootstrap();

    return () => {
      cancelled = true;
    };
  }, [loadKits, handleEdit]);

  const resetForm = () => {
    setKitId(null);
    setName('');
    setDescription('');
    setEffectiveFrom('');
    setEffectiveTo('');
    setRatePlanId('');
    setPricingOverrideJson('{}');
    setComponents([emptyComponent()]);
    setNotFoundError(null);
    onKitIdChangeRef.current?.(null);
  };

  const updateComponent = (index: number, next: KitComponentDraft) => {
    setComponents((prev) => prev.map((row, i) => (i === index ? next : row)));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaveError(null);
    setSavedMessage(null);

    let parsedPricingOverride: Record<string, unknown>;
    try {
      parsedPricingOverride = JSON.parse(pricingOverrideJson) as Record<string, unknown>;
    } catch {
      setSaveError('Pricing override must be valid JSON.');
      return;
    }

    setBusy(true);
    const payloadComponents = components
      .filter((component) => component.componentId.trim().length > 0)
      .map((component) => ({
        component_type: component.componentType,
        component_id: component.componentId,
        component_name: component.componentName || null,
        quantity: Number(component.quantity) > 0 ? Number(component.quantity) : 1,
        is_required: component.isRequired,
        is_default: component.isDefault,
        effective_from: component.effectiveFrom || null,
        effective_to: component.effectiveTo || null,
      }));

    const { data, error } = await supabase.rpc('staff_upsert_inventory_kit', {
      p_kit_id: kitId,
      p_name: name,
      p_description: description || null,
      p_effective_from: effectiveFrom || null,
      p_effective_to: effectiveTo || null,
      p_rate_plan_id: ratePlanId || null,
      p_pricing_override: parsedPricingOverride,
      p_components: payloadComponents,
    });

    setBusy(false);

    if (error || !data || data.length === 0) {
      console.error(`Inventory kit save failed: ${formatErrorDetail(error ?? 'empty response')}`);
      setSaveError(KIT_SAVE_ERROR_MESSAGE);
      return;
    }

    setSavedMessage(`Saved kit ${name}`);
    await loadKits();
    const row = data[0] as { kit_id: string };
    setKitId(row.kit_id);
    onKitIdChangeRef.current?.(row.kit_id);
  };

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6" data-testid="inventory-kits-screen">
      <div>
        <h1 className="text-2xl font-semibold">Inventory Kits & Bundles</h1>
        <p className="text-sm text-muted-foreground">
          Define reusable bundles that combine assets, categories, and stock items without duplicating inventory pools.
        </p>
      </div>

      {loadError && (
        <Alert variant="destructive" data-testid="kits-load-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load kit data</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {saveError && (
        <Alert variant="destructive" data-testid="kits-save-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Save failed</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      {notFoundError && (
        <Alert variant="destructive" data-testid="kits-not-found-error">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Kit not found</AlertTitle>
          <AlertDescription>{notFoundError}</AlertDescription>
        </Alert>
      )}

      {savedMessage && (
        <Alert data-testid="kits-save-success">
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>{savedMessage}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Existing kits</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {kits.length === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="kits-empty-state">
                No kits defined yet.
              </p>
            )}
            {kits.map((kit) => (
              <button
                key={kit.entity_id}
                type="button"
                onClick={() => void handleEdit(kit.entity_id)}
                disabled={busy}
                className="w-full rounded border p-3 text-left hover:bg-muted/40 disabled:opacity-60"
                data-testid={`kit-row-${kit.entity_id}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{kit.name}</span>
                  <Badge variant="outline">Edit</Badge>
                </div>
                {kit.description && <p className="text-xs text-muted-foreground mt-1">{kit.description}</p>}
              </button>
            ))}
          </CardContent>
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader>
            <CardTitle className="text-base">{kitId ? 'Edit kit' : 'Create kit'}</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={(event) => void submit(event)}>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="kit-name">Name</Label>
                  <Input id="kit-name" value={name} onChange={(e) => setName(e.target.value)} required data-testid="input-kit-name" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="kit-rate-plan">Rate Plan ID</Label>
                  <Input id="kit-rate-plan" value={ratePlanId} onChange={(e) => setRatePlanId(e.target.value)} data-testid="input-kit-rate-plan" />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="kit-description">Description</Label>
                <Textarea id="kit-description" value={description} onChange={(e) => setDescription(e.target.value)} data-testid="input-kit-description" />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="kit-effective-from">Effective From</Label>
                  <Input id="kit-effective-from" type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} data-testid="input-kit-effective-from" />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="kit-effective-to">Effective To</Label>
                  <Input id="kit-effective-to" type="date" value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} data-testid="input-kit-effective-to" />
                </div>
              </div>

              <div className="space-y-1">
                <Label htmlFor="kit-pricing-override">Pricing override (JSON)</Label>
                <Textarea
                  id="kit-pricing-override"
                  value={pricingOverrideJson}
                  onChange={(e) => setPricingOverrideJson(e.target.value)}
                  rows={4}
                  data-testid="input-kit-pricing-override"
                />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Components</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setComponents((prev) => [...prev, emptyComponent()])}
                    data-testid="btn-add-kit-component"
                  >
                    <Plus className="mr-1 h-4 w-4" />
                    Add component
                  </Button>
                </div>

                {components.map((component, index) => {
                  const componentOptions = componentOptionsByType[component.componentType] ?? [];
                  return (
                    <div key={`component-${index}`} className="rounded border p-3 space-y-2" data-testid={`kit-component-${index}`}>
                      <div className="grid gap-2 sm:grid-cols-3">
                        <div className="space-y-1">
                          <Label className="text-xs" htmlFor={`kit-component-type-${index}`}>Type</Label>
                          <select
                            id={`kit-component-type-${index}`}
                            value={component.componentType}
                            onChange={(e) =>
                              updateComponent(index, {
                                ...component,
                                componentType: e.target.value as KitComponentType,
                                componentId: '',
                                componentName: '',
                              })
                            }
                            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            data-testid={`input-kit-component-type-${index}`}
                          >
                            <option value="asset_category">Asset Category</option>
                            <option value="asset">Serialized Asset</option>
                            <option value="stock_item">Stock Item</option>
                          </select>
                        </div>

                        <div className="space-y-1 sm:col-span-2">
                          <Label className="text-xs" htmlFor={`kit-component-id-${index}`}>Component</Label>
                          <select
                            id={`kit-component-id-${index}`}
                            value={component.componentId}
                            onChange={(e) => {
                              const nextComponentId = e.target.value;
                              const selectedOptionLabel = e.target.options[e.target.selectedIndex]?.text?.trim() ?? '';
                              updateComponent(index, {
                                ...component,
                                componentId: nextComponentId,
                                componentName: nextComponentId ? selectedOptionLabel : '',
                              });
                            }}
                            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            data-testid={`input-kit-component-id-${index}`}
                          >
                            <option value="">Select component…</option>
                            {componentOptions.map((option) => (
                              <option key={option.id} value={option.id}>{option.label}</option>
                            ))}
                            {component.componentId && !componentOptions.some((opt) => opt.id === component.componentId) && (
                              <option key={component.componentId} value={component.componentId} title={component.componentId}>
                                {component.componentName || component.componentId.slice(0, 8)}
                              </option>
                            )}
                          </select>
                        </div>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-3">
                        <div className="space-y-1">
                          <Label className="text-xs" htmlFor={`kit-component-name-${index}`}>Name override</Label>
                          <Input
                            id={`kit-component-name-${index}`}
                            value={component.componentName}
                            onChange={(e) => updateComponent(index, { ...component, componentName: e.target.value })}
                            data-testid={`input-kit-component-name-${index}`}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs" htmlFor={`kit-component-quantity-${index}`}>Quantity</Label>
                          <Input
                            id={`kit-component-quantity-${index}`}
                            type="number"
                            min="0"
                            step="1"
                            value={component.quantity}
                            onChange={(e) => updateComponent(index, { ...component, quantity: e.target.value })}
                            data-testid={`input-kit-component-quantity-${index}`}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Flags</Label>
                          <div className="flex gap-3 pt-2 text-sm">
                            <label className="inline-flex items-center gap-1" htmlFor={`kit-component-required-${index}`}>
                              <input
                                id={`kit-component-required-${index}`}
                                type="checkbox"
                                checked={component.isRequired}
                                onChange={(e) => updateComponent(index, { ...component, isRequired: e.target.checked })}
                                data-testid={`input-kit-component-required-${index}`}
                              />
                              Required
                            </label>
                            <label className="inline-flex items-center gap-1" htmlFor={`kit-component-default-${index}`}>
                              <input
                                id={`kit-component-default-${index}`}
                                type="checkbox"
                                checked={component.isDefault}
                                onChange={(e) => updateComponent(index, { ...component, isDefault: e.target.checked })}
                                data-testid={`input-kit-component-default-${index}`}
                              />
                              Default
                            </label>
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-2 sm:grid-cols-2">
                        <div className="space-y-1">
                          <Label className="text-xs" htmlFor={`kit-component-effective-from-${index}`}>Effective From</Label>
                          <Input
                            id={`kit-component-effective-from-${index}`}
                            type="date"
                            value={component.effectiveFrom}
                            onChange={(e) => updateComponent(index, { ...component, effectiveFrom: e.target.value })}
                            data-testid={`input-kit-component-effective-from-${index}`}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs" htmlFor={`kit-component-effective-to-${index}`}>Effective To</Label>
                          <Input
                            id={`kit-component-effective-to-${index}`}
                            type="date"
                            value={component.effectiveTo}
                            onChange={(e) => updateComponent(index, { ...component, effectiveTo: e.target.value })}
                            data-testid={`input-kit-component-effective-to-${index}`}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="flex items-center gap-2">
                <Button type="submit" disabled={busy} data-testid="btn-save-kit">
                  {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
                  Save Kit
                </Button>
                <Button type="button" variant="outline" onClick={resetForm} disabled={busy} data-testid="btn-reset-kit-form">
                  New Draft
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

export function InventoryKitsPage() {
  const { kit_id } = Route.useSearch();
  const navigate = useNavigate();

  const handleKitIdChange = useCallback(
    (id: string | null) => {
      void navigate({
        search: id ? { kit_id: id } : {},
        replace: true,
      });
    },
    [navigate],
  );

  return <InventoryKitsScreen initialKitId={kit_id} onKitIdChange={handleKitIdChange} />;
}
