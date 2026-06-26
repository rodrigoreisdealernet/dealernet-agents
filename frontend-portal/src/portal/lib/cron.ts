// Human-readable cadence for the DIA agents' 5-field cron schedules.
//
// `ops_agent_status_view` exposes `next_run_at` but NOT the cron expression, so
// the dashboard maps the known DIA agent keys to their configured (seed) cron
// and renders a friendly cadence from it. `cronToHuman` is self-contained (no
// i18n/runtime dependency) so it can be unit-tested directly and returns the
// final localized string for the supported locales. It covers the seed patterns
// and returns `null` for anything it does not recognise (caller omits cadence).

export type CronLocale = 'pt-BR' | 'en-US'

// Seed crons for the four DIA agents (see supabase/seed.sql). Kept in sync with
// the worker defaults in temporal/src/worker.py.
export const DIA_AGENT_CRONS: Record<string, string> = {
  'vehicle-aging-analyst': '0 6 * * 1-5',
  'collections-prioritizer': '0 6 * * 1-5',
  'service-estimate-rescue': '0 7 * * 1-5',
  'parts-inventory-advisor': '0 6 * * 1',
}

const WEEKDAY_NAMES: Record<CronLocale, readonly string[]> = {
  // Indexed by cron day-of-week: Sun=0 .. Sat=6.
  'pt-BR': ['domingos', 'segundas', 'terças', 'quartas', 'quintas', 'sextas', 'sábados'],
  'en-US': ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'],
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0')
}

function normalizeLocale(locale: string | null | undefined): CronLocale {
  return locale === 'en-US' ? 'en-US' : 'pt-BR'
}

/**
 * Convert a 5-field cron expression into a human-readable cadence.
 * Examples: "0 6 * * 1-5" -> "dias úteis às 06:00" / "weekdays at 06:00".
 * Returns null for unsupported/invalid expressions.
 */
export function cronToHuman(cron: string | null | undefined, locale: string): string | null {
  if (!cron || typeof cron !== 'string') return null
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [min, hour, dom, mon, dow] = fields
  const loc = normalizeLocale(locale)
  const pt = loc === 'pt-BR'

  // Every-N-hours: "0 */6 * * *".
  const stepMatch = hour.match(/^\*\/(\d+)$/)
  if (min === '0' && stepMatch && dom === '*' && mon === '*' && dow === '*') {
    const n = Number(stepMatch[1])
    return pt ? `a cada ${n} horas` : `every ${n} hours`
  }

  // Fixed time of day (single minute + hour, any month).
  const m = Number(min)
  const h = Number(hour)
  if (min.includes('*') || hour.includes('*') || !Number.isInteger(m) || !Number.isInteger(h)) {
    return null
  }
  if (mon !== '*') return null
  const time = `${pad2(h)}:${pad2(m)}`
  const at = pt ? `às ${time}` : `at ${time}`

  // Weekdays (Mon-Fri).
  if (dom === '*' && dow === '1-5') {
    return pt ? `dias úteis ${at}` : `weekdays ${at}`
  }
  // Daily.
  if (dom === '*' && dow === '*') {
    return pt ? `todos os dias ${at}` : `daily ${at}`
  }
  // Single weekday (0-6).
  if (dom === '*' && /^[0-6]$/.test(dow)) {
    const name = WEEKDAY_NAMES[loc][Number(dow)]
    return `${name} ${at}`
  }
  return null
}

/** Cadence for a known DIA agent key, or null when not mapped/recognised. */
export function cadenceForAgent(agentKey: string, locale: string): string | null {
  return cronToHuman(DIA_AGENT_CRONS[agentKey], locale)
}
