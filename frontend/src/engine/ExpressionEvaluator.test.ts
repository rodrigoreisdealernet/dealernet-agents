import { describe, expect, it } from 'vitest';
import { evaluateExpression, createExpressionContext, resolveValue } from './ExpressionEvaluator';

describe('ExpressionEvaluator – formatDate built-in', () => {
  it('formats a UTC ISO timestamp as YYYY-MM-DD HH:mm UTC', () => {
    const context = createExpressionContext({
      data: { kpis: { as_of: '2026-06-06T16:02:00Z' } },
    });
    const result = evaluateExpression('{{formatDate(data.kpis.as_of)}}', context);
    expect(result).toBe('2026-06-06 16:02 UTC');
  });

  it('formats a timestamp with timezone offset correctly (normalized to UTC)', () => {
    const context = createExpressionContext({
      data: { kpis: { as_of: '2026-06-06T18:30:00+02:00' } },
    });
    const result = evaluateExpression('{{formatDate(data.kpis.as_of)}}', context);
    // 18:30 +02:00 = 16:30 UTC
    expect(result).toBe('2026-06-06 16:30 UTC');
  });

  it('returns empty string for null/undefined as_of', () => {
    const context = createExpressionContext({ data: { kpis: { as_of: null } } });
    expect(evaluateExpression('{{formatDate(data.kpis.as_of)}}', context)).toBe('');
  });

  it('returns empty string when as_of is missing', () => {
    const context = createExpressionContext({ data: { kpis: {} } });
    expect(evaluateExpression('{{formatDate(data.kpis.as_of)}}', context)).toBe('');
  });

  it('interpolates formatDate correctly inside a mixed string template', () => {
    const context = createExpressionContext({
      data: { kpis: { as_of: '2026-06-06T16:02:00Z' } },
    });
    const result = evaluateExpression('As of {{formatDate(data.kpis.as_of)}}', context);
    expect(result).toBe('As of 2026-06-06 16:02 UTC');
    // Ensure the literal placeholder is never rendered
    expect(result).not.toContain('(UTC ISO timestamp)');
  });

  it('formats date and currency using locale scope policy metadata', () => {
    const context = createExpressionContext({
      data: {
        branch_scope_config: {
          locale_code: 'en-GB',
          timezone: 'Europe/London',
          currency_code: 'GBP',
        },
      },
    });

    expect(evaluateExpression('{{formatCurrency(1234.5)}}', context)).toBe('£1,234.50');
    expect(evaluateExpression('{{formatDate("2026-06-06T16:30:00Z")}}', context)).toBe('06/06/2026, 17:30');
  });
});

describe('ExpressionEvaluator – formatCurrency built-in', () => {
  it('formats using an explicit non-USD currency code', () => {
    const result = evaluateExpression('{{formatCurrency(1250, "EUR")}}', createExpressionContext());
    expect(result).toBe('€1,250');
  });

  it('falls back to USD when currency code is invalid', () => {
    const result = evaluateExpression('{{formatCurrency(1250, "BADCODE")}}', createExpressionContext());
    expect(result).toBe('$1,250');
  });

  it('keeps cents for fractional values and handles negative values', () => {
    expect(evaluateExpression('{{formatCurrency(-10.5)}}', createExpressionContext())).toBe('-$10.50');
  });

  it('handles null and zero values', () => {
    expect(evaluateExpression('{{formatCurrency(null)}}', createExpressionContext())).toBe('$0');
    expect(evaluateExpression('{{formatCurrency(0)}}', createExpressionContext())).toBe('$0');
  });
});

describe('ExpressionEvaluator – formatDateTime and formatPercent built-ins', () => {
  it('formats date-time in short UI format', () => {
    const result = evaluateExpression('{{formatDateTime("2026-06-11T14:45:00Z")}}', createExpressionContext());
    expect(result).toBe('Jun 11, 2:45 pm');
  });

  it('returns empty string for null date-time value', () => {
    const result = evaluateExpression('{{formatDateTime(null)}}', createExpressionContext());
    expect(result).toBe('');
  });

  it('formats percent values including zero and negative', () => {
    expect(evaluateExpression('{{formatPercent(0)}}', createExpressionContext())).toBe('0%');
    expect(evaluateExpression('{{formatPercent(0.125)}}', createExpressionContext())).toBe('12.5%');
    expect(evaluateExpression('{{formatPercent(-0.2)}}', createExpressionContext())).toBe('-20%');
  });
});

describe('ExpressionEvaluator – lookupEntityFieldById built-in', () => {
  it('resolves a related entity display field by id', () => {
    const context = createExpressionContext({
      data: {
        customers: [
          { id: 'customer-1', entity_versions: [{ data: { name: 'Acme Construction' } }] },
        ],
        invoice: { entity_versions: [{ data: { customer_id: 'customer-1' } }] },
      },
    });

    const result = evaluateExpression(
      "{{lookupEntityFieldById(data.customers, data.invoice.entity_versions[0].data.customer_id, 'name')}}",
      context
    );
    expect(result).toBe('Acme Construction');
  });

  it('returns N/A when a related id cannot be resolved', () => {
    const context = createExpressionContext({
      data: {
        customers: [{ id: 'customer-1', entity_versions: [{ data: { name: 'Acme Construction' } }] }],
      },
    });

    const result = evaluateExpression(
      "{{lookupEntityFieldById(data.customers, 'customer-missing', 'name')}}",
      context
    );
    expect(result).toBe('N/A');
  });
});

describe('ExpressionEvaluator – ops wording helpers', () => {
  it('maps ops agent keys to business workflow labels', () => {
    const result = evaluateExpression("{{formatOpsAgentLabel('revrec-analyst')}}", createExpressionContext());
    expect(result).toBe('Revenue Recognition');
  });

  it('maps the damage assistant key to a readable label', () => {
    const result = evaluateExpression(
      "{{formatOpsAgentLabel('damage-returns-charge-assistant')}}",
      createExpressionContext()
    );
    expect(result).toBe('Damage & Returns Charges');
  });

  it('maps the credit analyst key to the collections label', () => {
    const result = evaluateExpression(
      "{{formatOpsAgentLabel('credit-analyst')}}",
      createExpressionContext()
    );
    expect(result).toBe('AR Collections');
  });

  it('normalizes audit labels away from agent wording', () => {
    const result = evaluateExpression("{{formatOpsAuditLabel('Agent proposed')}}", createExpressionContext());
    expect(result).toBe('Workflow proposed');
  });

  it('summarizes known ops audit event payloads in operator language', () => {
    const result = evaluateExpression(
      "{{formatOpsAuditSummary(data.auditPayload, 'Agent review')}}",
      createExpressionContext({
        data: {
          auditPayload: { event_type: 'finding_rejected', reason: 'manual override' },
        },
      })
    );
    expect(result).toBe('Finding rejected: manual override');
  });

  it('falls back to a readable audit-label summary when no payload details exist', () => {
    const result = evaluateExpression(
      "{{formatOpsAuditSummary({}, 'Agent proposed')}}",
      createExpressionContext()
    );
    expect(result).toBe('Workflow proposed recorded.');
  });
});

describe('ExpressionEvaluator – rerent fulfillment wording helper', () => {
  it('maps rerent fulfillment status keys to readable labels', () => {
    const result = evaluateExpression(
      "{{formatRerentFulfillmentStatus('pending_vendor_confirmation')}}",
      createExpressionContext()
    );
    expect(result).toBe('pending vendor confirmation');
  });
});

describe('ExpressionEvaluator – re-rent routing context helper', () => {
  it('treats persisted re-rent status as routed even without fulfillment_source', () => {
    const result = evaluateExpression(
      "{{hasRerentRoutingContext('', 'pending_vendor_confirmation', 'preferred_vendor')}}",
      createExpressionContext()
    );
    expect(result).toBe(true);
  });

  it('treats a preferred-vendor shortage route as routed context', () => {
    const result = evaluateExpression(
      "{{hasRerentRoutingContext('', '', 'preferred_vendor')}}",
      createExpressionContext()
    );
    expect(result).toBe(true);
  });

  it('returns false when no rerent routing context exists', () => {
    const result = evaluateExpression("{{hasRerentRoutingContext('', '', '')}}", createExpressionContext());
    expect(result).toBe(false);
  });

  it('labels internal substitutes separately from default internal stock', () => {
    const result = evaluateExpression(
      "{{getFulfillmentChannelLabel('internal_substitute', '', 'same_category_other_location')}}",
      createExpressionContext()
    );
    expect(result).toBe('internal substitute');
  });
});

describe('ExpressionEvaluator – rerent vendor-path wording helper', () => {
  it('maps rerent vendor-path keys to readable labels', () => {
    const result = evaluateExpression(
      "{{formatRerentVendorPath('manual_override')}}",
      createExpressionContext()
    );
    expect(result).toBe('manual override path');
  });
});

describe('ExpressionEvaluator – rerent unit status wording helper', () => {
  it.each([
    ['requested',         'Requested'],
    ['awarded',           'Awarded'],
    ['dispatched',        'Dispatched'],
    ['on_rent',           'On Rent'],
    ['return_in_transit', 'Return in Transit'],
    ['returned',          'Returned'],
  ])('maps %s to readable label %s', (key, expected) => {
    const result = evaluateExpression(
      `{{formatRerentUnitStatus('${key}')}}`,
      createExpressionContext()
    );
    expect(result).toBe(expected);
  });

  it('passes through unknown status keys unchanged', () => {
    const result = evaluateExpression(
      "{{formatRerentUnitStatus('unknown_key')}}",
      createExpressionContext()
    );
    expect(result).toBe('unknown_key');
  });

  it('returns empty string for empty input', () => {
    const result = evaluateExpression(
      "{{formatRerentUnitStatus('')}}",
      createExpressionContext()
    );
    expect(result).toBe('');
  });
});

describe('ExpressionEvaluator – hasRerentUnitStatus helper', () => {
  it('returns true when a matching status log entry exists for the line', () => {
    const context = createExpressionContext({
      data: {
        rerent_unit_status: [
          { order_line_id: 'line-1', status_key: 'dispatched' },
        ],
      },
    });
    const result = evaluateExpression(
      "{{hasRerentUnitStatus(data.rerent_unit_status, 'line-1')}}",
      context
    );
    expect(result).toBe(true);
  });

  it('returns false when the status array is empty', () => {
    const context = createExpressionContext({ data: { rerent_unit_status: [] } });
    const result = evaluateExpression(
      "{{hasRerentUnitStatus(data.rerent_unit_status, 'line-1')}}",
      context
    );
    expect(result).toBe(false);
  });

  it('returns false when no entry matches the given line id', () => {
    const context = createExpressionContext({
      data: {
        rerent_unit_status: [
          { order_line_id: 'line-other', status_key: 'on_rent' },
        ],
      },
    });
    const result = evaluateExpression(
      "{{hasRerentUnitStatus(data.rerent_unit_status, 'line-1')}}",
      context
    );
    expect(result).toBe(false);
  });

  it('returns false when status_key is empty for the matched entry', () => {
    const context = createExpressionContext({
      data: {
        rerent_unit_status: [
          { order_line_id: 'line-1', status_key: '' },
        ],
      },
    });
    const result = evaluateExpression(
      "{{hasRerentUnitStatus(data.rerent_unit_status, 'line-1')}}",
      context
    );
    expect(result).toBe(false);
  });
});

describe('ExpressionEvaluator – rerent helpers', () => {
  it('detects shortage from availability rows', () => {
    const context = createExpressionContext({
      data: {
        availability: [{ branch_id: 'branch-1', asset_category_id: 'cat-forklift', available_assets: 1 }],
      },
    });

    expect(
      evaluateExpression(
        "{{hasAvailabilityShortage(data.availability, 'cat-forklift', 'branch-1', 3)}}",
        context
      )
    ).toBe(true);
  });

  it('builds rerent payload without manual override fields on preferred path', () => {
    const context = createExpressionContext({
      state: {
        rerentExistingLineData: {
          order_id: 'order-1',
          planned_start: '2026-08-01',
        },
      },
    });
    const payload = evaluateExpression(
      "{{buildRerentLineData(state.rerentExistingLineData, 'cat-forklift', '3', '1', 'primary_preferred', 'pending_vendor_confirmation', '', 'admin')}}",
      context
    ) as Record<string, unknown>;

    expect(payload.order_id).toBe('order-1');
    expect(payload.planned_start).toBe('2026-08-01');
    expect(payload.quantity).toBe(3);
    expect(payload.internal_available_quantity).toBe(1);
    expect(payload).not.toHaveProperty('manual_override_reason');
    expect(payload).not.toHaveProperty('manual_override_role');
  });
});

describe('ExpressionEvaluator – substitute recommendation helpers', () => {
  it('builds substitute payload with audit metadata and selected branch/category', () => {
    const context = createExpressionContext({
      state: {
        existingLineData: {
          order_id: 'order-1',
          planned_start: '2026-08-01',
          planned_end: '2026-08-31',
          rerent_vendor_path: 'manual_override',
        },
        quoteLine: {
          line_entity_id: 'line-1',
          requested_quantity: 3,
          branch_id: 'branch-1',
          asset_category_id: 'cat-forklift',
        },
        alternative: {
          branch_id: 'branch-2',
          branch_name: 'North Yard',
          asset_category_id: 'cat-forklift',
          asset_category_name: 'Forklifts',
          available_quantity: 4,
          fit_type: 'same_category_other_location',
          explanation: 'Same category at a different location',
        },
      },
    });

    const payload = evaluateExpression(
      "{{buildSubstituteLineData(state.existingLineData, state.quoteLine, state.alternative, 'admin')}}",
      context
    ) as Record<string, unknown>;

    expect(payload.order_id).toBe('order-1');
    expect(payload.branch_id).toBe('branch-2');
    expect(payload.category_id).toBe('cat-forklift');
    expect(payload.fulfillment_source).toBe('internal_substitute');
    expect(payload).not.toHaveProperty('rerent_vendor_path');
    expect(payload.substitute_recommendation).toEqual({
      line_entity_id: 'line-1',
      requested_quantity: 3,
      original_branch_id: 'branch-1',
      original_asset_category_id: 'cat-forklift',
      selected_branch_id: 'branch-2',
      selected_branch_name: 'North Yard',
      selected_asset_category_id: 'cat-forklift',
      selected_asset_category_name: 'Forklifts',
      selected_available_quantity: 4,
      fit_type: 'same_category_other_location',
      explanation: 'Same category at a different location',
      selected_by_role: 'admin',
    });
  });
});

describe('ExpressionEvaluator – lookupRecordFieldById built-in', () => {
  it('resolves a record field by id from an arbitrary array', () => {
    const context = createExpressionContext({
      data: {
        lines: [
          { entity_id: 'line-1', asset_id: 'asset-123' },
          { entity_id: 'line-2', asset_id: 'asset-456' },
        ],
      },
      state: {
        return_line_id: 'line-1',
      },
    });

    const result = evaluateExpression(
      "{{lookupRecordFieldById(data.lines, state.return_line_id, 'asset_id', 'entity_id')}}",
      context
    );

    expect(result).toBe('asset-123');
  });

  it('returns undefined when no matching record exists', () => {
    const context = createExpressionContext({
      data: {
        lines: [{ entity_id: 'line-1', asset_id: 'asset-123' }],
      },
      state: {
        return_line_id: 'line-missing',
      },
    });

    const result = evaluateExpression(
      "{{lookupRecordFieldById(data.lines, state.return_line_id, 'asset_id', 'entity_id')}}",
      context
    );

    expect(result).toBeUndefined();
  });
});

describe('ExpressionEvaluator – getAvailabilityField built-in', () => {
  it('resolves available asset count by category and branch', () => {
    const context = createExpressionContext({
      data: {
        availability: [
          { branch_id: 'branch-1', asset_category_id: 'cat-forklift', available_assets: 3 },
          { branch_id: 'branch-2', asset_category_id: 'cat-forklift', available_assets: 1 },
        ],
      },
      params: {
        branchId: 'branch-1',
      },
    });

    const result = evaluateExpression(
      "{{getAvailabilityField(data.availability, 'cat-forklift', params.branchId, 'available_assets')}}",
      context
    );

    expect(result).toBe(3);
  });

  it('returns 0 when no matching availability record exists', () => {
    const context = createExpressionContext({
      data: {
        availability: [{ branch_id: 'branch-2', asset_category_id: 'cat-boom', available_assets: 2 }],
      },
    });

    const result = evaluateExpression(
      "{{getAvailabilityField(data.availability, 'cat-forklift', 'branch-1', 'available_assets')}}",
      context
    );

    expect(result).toBe(0);
  });
});

describe('ExpressionEvaluator – ensureArray built-in', () => {
  it('returns an empty array when the source value is missing', () => {
    const context = createExpressionContext({ data: {} });
    expect(evaluateExpression('{{ensureArray(data.quote_availability)}}', context)).toEqual([]);
  });
});


describe('ExpressionEvaluator – mergeRecordFieldById built-in', () => {
  it('merges overrides into an existing record while preserving context fields', () => {
    const context = createExpressionContext({
      data: {
        lines: [
          {
            entity_id: 'line-1',
            version_id: 'ver-1',
            version_number: 3,
            status: 'checked_out',
            contract_id: 'contract-1',
            asset_id: 'asset-123',
            category_id: 'cat-excavator',
            rate_type: 'daily',
            rate_amount: 8000,
            actual_start: '2026-06-15',
            actual_end: null,
            data: { planned_end: '2026-07-01' },
          },
        ],
      },
      state: {
        return_line_id: 'line-1',
        return_actual_end: '2026-06-30',
      },
      params: {
        id: 'contract-1',
      },
    });

    const result = evaluateExpression(
      "{{mergeRecordFieldById(data.lines, state.return_line_id, 'entity_id', 'status', 'returned', 'contract_id', params.id, 'actual_end', state.return_actual_end)}}",
      context
    );

    expect(result).toEqual({
      status: 'returned',
      contract_id: 'contract-1',
      asset_id: 'asset-123',
      category_id: 'cat-excavator',
      rate_type: 'daily',
      rate_amount: 8000,
      actual_start: '2026-06-15',
      actual_end: '2026-06-30',
      data: { planned_end: '2026-07-01' },
    });
  });
});

describe('ExpressionEvaluator – operator precedence and logical parsing', () => {
  it('treats comparison as tighter than logical OR for null empty-state expressions', () => {
    const context = createExpressionContext({
      data: { entities: null },
    });

    expect(evaluateExpression('{{!data.entities || data.entities.length === 0}}', context)).toBe(true);
  });

  it('returns expected empty-state result for null, undefined, empty array, and populated array', () => {
    expect(
      evaluateExpression(
        '{{!data.x || data.x.length === 0}}',
        createExpressionContext({ data: { x: null } })
      )
    ).toBe(true);

    expect(
      evaluateExpression(
        '{{!data.x || data.x.length === 0}}',
        createExpressionContext({ data: {} })
      )
    ).toBe(true);

    expect(
      evaluateExpression(
        '{{!data.x || data.x.length === 0}}',
        createExpressionContext({ data: { x: [] } })
      )
    ).toBe(true);

    expect(
      evaluateExpression(
        '{{!data.x || data.x.length === 0}}',
        createExpressionContext({ data: { x: [{ id: 'row-1' }] } })
      )
    ).toBe(false);
  });

  it('applies arithmetic before comparison', () => {
    const context = createExpressionContext();
    expect(evaluateExpression('{{1 + 2 === 3}}', context)).toBe(true);
    expect(evaluateExpression('{{10 - 3 > 5}}', context)).toBe(true);
  });

  it('applies logical precedence between && and ||', () => {
    const context = createExpressionContext();
    expect(evaluateExpression('{{false && true || true}}', context)).toBe(true);
    expect(evaluateExpression('{{true || false && false}}', context)).toBe(true);
  });

  it('supports ternary expressions mixed with comparison and logical operators', () => {
    expect(
      evaluateExpression(
        "{{data.x && data.x.length > 0 ? 'rows' : 'empty'}}",
        createExpressionContext({ data: { x: null } })
      )
    ).toBe('empty');

    expect(
      evaluateExpression(
        "{{data.x && data.x.length > 0 ? 'rows' : 'empty'}}",
        createExpressionContext({ data: { x: [{ id: 'row-1' }] } })
      )
    ).toBe('rows');
  });

  it('does not split && and || inside quoted string literals', () => {
    const context = createExpressionContext();
    expect(evaluateExpression("{{'a || b' === 'a || b' && true}}", context)).toBe(true);
    expect(evaluateExpression("{{'a && b' === 'a && b' || false}}", context)).toBe(true);
  });
});

describe('ExpressionEvaluator – nested action expression resolution', () => {
  it('resolves nested sequence action values from loop context', () => {
    const resolved = resolveValue(
      {
        action: 'sequence',
        actions: [
          {
            action: 'setState',
            key: 'line_id',
            value: '{{line.id}}',
          },
        ],
      },
      createExpressionContext({
        line: { id: 'line-42' },
      })
    ) as { actions: Array<{ value: unknown }> };

    expect(resolved.actions[0].value).toBe('line-42');
  });
});

describe('ExpressionEvaluator – storefront cart helpers', () => {
  const assetCtx = (dailyRate: number, weeklyRate: number, monthlyRate: number) =>
    createExpressionContext({
      data: {
        asset: {
          entity_versions: [
            { data: { daily_rate: dailyRate, weekly_rate: weeklyRate, monthly_rate: monthlyRate } },
          ],
        },
      },
    });

  it('computeRentalSubtotal uses daily rate for short rentals', () => {
    expect(
      evaluateExpression('{{computeRentalSubtotal(800, 4200, 14000, 3)}}', createExpressionContext())
    ).toBe(2400);
  });

  it('computeRentalSubtotal uses weekly rate for 7-day rentals', () => {
    expect(
      evaluateExpression('{{computeRentalSubtotal(800, 4200, 14000, 7)}}', createExpressionContext())
    ).toBe(4200);
  });

  it('computeRentalSubtotal uses weekly rate for 14-day rentals', () => {
    expect(
      evaluateExpression('{{computeRentalSubtotal(800, 4200, 14000, 14)}}', createExpressionContext())
    ).toBe(8400);
  });

  it('computeRentalSubtotal uses monthly rate for 28-day rentals', () => {
    expect(
      evaluateExpression('{{computeRentalSubtotal(800, 4200, 14000, 28)}}', createExpressionContext())
    ).toBe(14000);
  });

  it('computeRentalSubtotal returns 0 for 0 days', () => {
    expect(
      evaluateExpression('{{computeRentalSubtotal(800, 4200, 14000, 0)}}', createExpressionContext())
    ).toBe(0);
  });

  it('computeDamageWaiverFee returns 12% of subtotal when enabled', () => {
    expect(
      evaluateExpression('{{computeDamageWaiverFee(2400, true)}}', createExpressionContext())
    ).toBe(288);
  });

  it('computeDamageWaiverFee returns 0 when disabled', () => {
    expect(
      evaluateExpression('{{computeDamageWaiverFee(2400, false)}}', createExpressionContext())
    ).toBe(0);
  });

  it('computeDeliveryFee returns 150 when enabled', () => {
    expect(
      evaluateExpression('{{computeDeliveryFee(true)}}', createExpressionContext())
    ).toBe(150);
  });

  it('computeDeliveryFee returns 0 when disabled', () => {
    expect(
      evaluateExpression('{{computeDeliveryFee(false)}}', createExpressionContext())
    ).toBe(0);
  });

  it('computeCartTotal sums rental, waiver, and delivery', () => {
    // 3 days × $800 = $2400 + 12% waiver ($288) + delivery ($150) = $2838
    expect(
      evaluateExpression('{{computeCartTotal(800, 4200, 14000, 3, true, true)}}', createExpressionContext())
    ).toBe(2838);
  });

  it('computeCartTotal with no add-ons equals rental subtotal', () => {
    expect(
      evaluateExpression('{{computeCartTotal(800, 4200, 14000, 3, false, false)}}', createExpressionContext())
    ).toBe(2400);
  });

  it('getCartCrossSellAssets filters to same category and excludes current asset', () => {
    const excavatorCategoryId = 'cat-earthmoving';
    const currentAssetId = 'asset-1';
    const assets = [
      {
        id: 'asset-1',
        entity_versions: [{ data: { name: 'CAT 320', asset_category_id: excavatorCategoryId, status: 'available' } }],
      },
      {
        id: 'asset-2',
        entity_versions: [{ data: { name: 'Komatsu PC360', asset_category_id: excavatorCategoryId, status: 'available' } }],
      },
      {
        id: 'asset-3',
        entity_versions: [{ data: { name: 'JLG Boom Lift', asset_category_id: 'cat-lifts', status: 'available' } }],
      },
    ];

    const context = createExpressionContext({ data: { assets } });
    const result = evaluateExpression(
      `{{getCartCrossSellAssets(data.assets, '${excavatorCategoryId}', '${currentAssetId}')}}`,
      context
    ) as Array<{ id: string }>;

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('asset-2');
  });

  it('getCartCrossSellAssets excludes non-available assets', () => {
    const categoryId = 'cat-earthmoving';
    const assets = [
      {
        id: 'asset-1',
        entity_versions: [{ data: { name: 'CAT 320', asset_category_id: categoryId, status: 'available' } }],
      },
      {
        id: 'asset-2',
        entity_versions: [{ data: { name: 'CAT 308', asset_category_id: categoryId, status: 'on_rent' } }],
      },
    ];
    const context = createExpressionContext({ data: { assets } });
    const result = evaluateExpression(
      `{{getCartCrossSellAssets(data.assets, '${categoryId}', 'none')}}`,
      context
    ) as Array<{ id: string }>;

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('asset-1');
  });

  it('getCartCrossSellAssets caps results at 3', () => {
    const categoryId = 'cat-earthmoving';
    const assets = Array.from({ length: 5 }, (_, i) => ({
      id: `asset-${i + 1}`,
      entity_versions: [{ data: { name: `Asset ${i + 1}`, asset_category_id: categoryId, status: 'available' } }],
    }));
    const context = createExpressionContext({ data: { assets } });
    const result = evaluateExpression(
      `{{getCartCrossSellAssets(data.assets, '${categoryId}', 'none')}}`,
      context
    ) as unknown[];

    expect(result).toHaveLength(3);
  });

  it('countCartCrossSellAssets returns the count of cross-sell items', () => {
    const categoryId = 'cat-earthmoving';
    const assets = [
      {
        id: 'asset-1',
        entity_versions: [{ data: { name: 'CAT 320', asset_category_id: categoryId, status: 'available' } }],
      },
      {
        id: 'asset-2',
        entity_versions: [{ data: { name: 'CAT 308', asset_category_id: categoryId, status: 'available' } }],
      },
    ];
    const context = createExpressionContext({ data: { assets } });
    const count = evaluateExpression(
      `{{countCartCrossSellAssets(data.assets, '${categoryId}', 'asset-1')}}`,
      context
    );

    expect(count).toBe(1);
  });

  it('resolves computeRentalSubtotal from asset data context via expression template', () => {
    const ctx = assetCtx(800, 4200, 14000);
    expect(
      evaluateExpression(
        '{{computeRentalSubtotal(data.asset.entity_versions[0].data.daily_rate, data.asset.entity_versions[0].data.weekly_rate, data.asset.entity_versions[0].data.monthly_rate, 7)}}',
        ctx
      )
    ).toBe(4200);
  });
});

describe('ExpressionEvaluator – uuid() built-in', () => {
  it('returns a valid RFC 4122 UUID v4 string', () => {
    const ctx = createExpressionContext();
    const result = evaluateExpression('{{uuid()}}', ctx);
    expect(typeof result).toBe('string');
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('generates a different UUID on each call', () => {
    const ctx = createExpressionContext();
    const first = evaluateExpression('{{uuid()}}', ctx);
    const second = evaluateExpression('{{uuid()}}', ctx);
    expect(first).not.toBe(second);
  });

  it('can be used inside a larger expression template string', () => {
    const ctx = createExpressionContext({ state: { prefix: 'cust' } });
    const result = evaluateExpression('{{state.prefix}}-{{uuid()}}', ctx) as string;
    expect(result).toMatch(/^cust-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});
