export type LocalePolicySource = 'user' | 'branch' | 'region' | 'company' | 'default';

export interface ScopeLocaleConfig {
  localeCode?: string | null;
  taxRegionCode?: string | null;
  timezone?: string | null;
  currencyCode?: string | null;
  currencyMinorUnit?: number | null;
}

export interface LocaleFormatPolicy {
  localeCode: string;
  taxRegionCode: string;
  timezone: string;
  currencyCode: string;
  currencyMinorUnit: number;
  resolvedFrom: LocalePolicySource;
}

type LocaleFallback = Omit<LocaleFormatPolicy, 'resolvedFrom'>;

const DEFAULT_POLICY: LocaleFallback = {
  localeCode: 'en-US',
  taxRegionCode: 'US-SALES',
  timezone: 'America/New_York',
  currencyCode: 'USD',
  currencyMinorUnit: 2,
};

const LOCALE_FALLBACKS: Record<string, Partial<LocaleFallback>> = {
  'en-us': DEFAULT_POLICY,
  'en-gb': {
    localeCode: 'en-GB',
    taxRegionCode: 'GB-VAT',
    timezone: 'Europe/London',
    currencyCode: 'GBP',
    currencyMinorUnit: 2,
  },
};

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanMinorUnit(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 6) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 6) {
      return parsed;
    }
  }
  return undefined;
}

function normalizeLocaleCode(value: unknown): string | undefined {
  const cleaned = cleanString(value);
  if (!cleaned) return undefined;
  const [language = '', region = ''] = cleaned.split('-');
  if (!language) return undefined;
  return `${language.toLowerCase()}${region ? `-${region.toUpperCase()}` : ''}`;
}

function normalizeScopeConfig(scope: ScopeLocaleConfig | null | undefined): ScopeLocaleConfig | null {
  if (!scope) return null;
  return {
    localeCode: normalizeLocaleCode(scope.localeCode),
    taxRegionCode: cleanString(scope.taxRegionCode),
    timezone: cleanString(scope.timezone),
    currencyCode: cleanString(scope.currencyCode)?.toUpperCase(),
    currencyMinorUnit: cleanMinorUnit(scope.currencyMinorUnit),
  };
}

function hasAnyConfig(scope: ScopeLocaleConfig | null): scope is ScopeLocaleConfig {
  return Boolean(scope && (scope.localeCode || scope.taxRegionCode || scope.timezone || scope.currencyCode || scope.currencyMinorUnit !== undefined));
}

export function resolveLocalePolicy(input: {
  userOverride?: ScopeLocaleConfig | null;
  branch?: ScopeLocaleConfig | null;
  region?: ScopeLocaleConfig | null;
  company?: ScopeLocaleConfig | null;
}): LocaleFormatPolicy {
  const normalizedBySource: Array<{ source: LocalePolicySource; config: ScopeLocaleConfig | null }> = [
    { source: 'user', config: normalizeScopeConfig(input.userOverride) },
    { source: 'branch', config: normalizeScopeConfig(input.branch) },
    { source: 'region', config: normalizeScopeConfig(input.region) },
    { source: 'company', config: normalizeScopeConfig(input.company) },
  ];

  const resolved = normalizedBySource.find(({ config }) => hasAnyConfig(config));
  const resolvedConfig = resolved?.config ?? null;
  const fallbackKey = (resolvedConfig?.localeCode || DEFAULT_POLICY.localeCode).toLowerCase();
  const localeFallback = LOCALE_FALLBACKS[fallbackKey] || {};

  return {
    localeCode: resolvedConfig?.localeCode || localeFallback.localeCode || DEFAULT_POLICY.localeCode,
    taxRegionCode: resolvedConfig?.taxRegionCode || localeFallback.taxRegionCode || DEFAULT_POLICY.taxRegionCode,
    timezone: resolvedConfig?.timezone || localeFallback.timezone || DEFAULT_POLICY.timezone,
    currencyCode: resolvedConfig?.currencyCode || localeFallback.currencyCode || DEFAULT_POLICY.currencyCode,
    currencyMinorUnit:
      resolvedConfig?.currencyMinorUnit
      ?? localeFallback.currencyMinorUnit
      ?? DEFAULT_POLICY.currencyMinorUnit,
    resolvedFrom: resolved?.source || 'default',
  };
}

export function formatLocalizedCurrency(value: number, policy: LocaleFormatPolicy): string {
  const numeric = Number.isFinite(value) ? value : 0;
  try {
    return new Intl.NumberFormat(policy.localeCode, {
      style: 'currency',
      currency: policy.currencyCode,
      minimumFractionDigits: policy.currencyMinorUnit,
      maximumFractionDigits: policy.currencyMinorUnit,
    }).format(numeric);
  } catch {
    return new Intl.NumberFormat(DEFAULT_POLICY.localeCode, {
      style: 'currency',
      currency: DEFAULT_POLICY.currencyCode,
      minimumFractionDigits: DEFAULT_POLICY.currencyMinorUnit,
      maximumFractionDigits: DEFAULT_POLICY.currencyMinorUnit,
    }).format(numeric);
  }
}

export function formatLocalizedNumber(value: number, policy: LocaleFormatPolicy): string {
  const numeric = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat(policy.localeCode).format(numeric);
}

export function formatLocalizedDate(
  value: string | number | Date,
  policy: LocaleFormatPolicy,
  options: Intl.DateTimeFormatOptions = {}
): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat(policy.localeCode, {
    timeZone: policy.timezone,
    ...options,
  }).format(parsed);
}

export function formatLocalizedDateTime(
  value: string | number | Date,
  policy: LocaleFormatPolicy,
  options: Intl.DateTimeFormatOptions = {}
): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  const hasExplicitDateOrTimeParts = [
    'weekday',
    'year',
    'month',
    'day',
    'hour',
    'minute',
    'second',
    'fractionalSecondDigits',
    'timeZoneName',
  ].some((part) => part in options);
  return new Intl.DateTimeFormat(policy.localeCode, {
    timeZone: policy.timezone,
    ...(hasExplicitDateOrTimeParts ? {} : { dateStyle: 'medium', timeStyle: 'short' }),
    ...options,
  }).format(parsed);
}
