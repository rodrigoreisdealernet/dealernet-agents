import { describe, expect, it } from 'vitest';
import {
  formatLocalizedCurrency,
  formatLocalizedDate,
  resolveLocalePolicy,
} from '@/lib/localePolicy';

describe('locale policy', () => {
  it('resolves explicit precedence user -> branch -> region -> company', () => {
    const policy = resolveLocalePolicy({
      userOverride: { localeCode: 'en-US' },
      branch: { localeCode: 'en-GB' },
      region: { localeCode: 'en-AU' },
      company: { localeCode: 'en-CA' },
    });

    expect(policy.localeCode).toBe('en-US');
    expect(policy.resolvedFrom).toBe('user');
  });

  it('falls back to branch then locale defaults for en-GB metadata', () => {
    const policy = resolveLocalePolicy({
      branch: { localeCode: 'en-GB' },
      company: { localeCode: 'en-US', currencyCode: 'USD' },
    });

    expect(policy.localeCode).toBe('en-GB');
    expect(policy.currencyCode).toBe('GBP');
    expect(policy.taxRegionCode).toBe('GB-VAT');
    expect(policy.resolvedFrom).toBe('branch');
  });

  it('formats values using locale-aware currency and dates', () => {
    const policy = resolveLocalePolicy({
      branch: { localeCode: 'en-GB', timezone: 'Europe/London', currencyCode: 'GBP' },
    });

    expect(formatLocalizedCurrency(1234.5, policy)).toBe('£1,234.50');
    expect(
      formatLocalizedDate('2026-06-01T12:00:00.000Z', policy, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    ).toBe('01/06/2026');
  });
});
