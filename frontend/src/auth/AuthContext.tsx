/**
 * AuthContext — tracks the Supabase session and exposes role/tenant helpers.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from '@/data/supabase';
import type { AppRole, UserProfile } from './types';
import { canWrite, canOperate } from './types';

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface AuthContextValue {
  /** Current session (null = unauthenticated / loading). */
  session: Session | null;
  /** Resolved user profile, or null when not signed in. */
  profile: UserProfile | null;
  /** True while the initial session is being resolved. */
  isLoading: boolean;
  /** Sign in with email + password; throws on failure. */
  signIn(email: string, password: string): Promise<void>;
  /** Sign out the current user. */
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Derive a UserProfile from a Supabase User object. */
function readStringArray(value: unknown): string[] | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return values.length > 0 ? Array.from(new Set(values)) : undefined;
}

function profileFromUser(user: User): UserProfile {
  const meta = (user.app_metadata ?? {}) as Record<string, unknown>;
  const userMeta = (user.user_metadata ?? {}) as Record<string, string>;
  const parsedCurrencyMinorUnit = Number(meta.currency_minor_unit);
  const currencyMinorUnit =
    Number.isInteger(parsedCurrencyMinorUnit) && parsedCurrencyMinorUnit >= 0
      ? parsedCurrencyMinorUnit
      : undefined;
  const billingAccountIds = readStringArray(meta.billing_account_ids) ?? readStringArray(meta.billing_account_id);
  const jobSiteIds = readStringArray(meta.job_site_ids) ?? readStringArray(meta.job_site_id);
  const contractIds = readStringArray(meta.contract_ids) ?? readStringArray(meta.contract_id);
  return {
    id: user.id,
    email: user.email ?? '',
    displayName:
      userMeta.display_name ||
      (user.email ? user.email.split('@')[0] : 'User'),
    role: (meta.role as AppRole) ?? 'read_only',
    tenant: typeof meta.tenant === 'string' ? meta.tenant : 'default',
    localeCode: typeof meta.locale_code === 'string' ? meta.locale_code : undefined,
    taxRegionCode: typeof meta.tax_region_code === 'string' ? meta.tax_region_code : undefined,
    timezone: typeof meta.timezone === 'string' ? meta.timezone : undefined,
    currencyCode: typeof meta.currency_code === 'string' ? meta.currency_code : undefined,
    currencyMinorUnit,
    branchId: typeof meta.branch_id === 'string' ? meta.branch_id : undefined,
    regionId: typeof meta.region_id === 'string' ? meta.region_id : undefined,
    companyId: typeof meta.company_id === 'string' ? meta.company_id : undefined,
    customerId: typeof meta.customer_id === 'string' ? meta.customer_id : undefined,
    billingAccountId: typeof meta.billing_account_id === 'string' ? meta.billing_account_id : undefined,
    billingAccountIds,
    jobSiteId: typeof meta.job_site_id === 'string' ? meta.job_site_id : undefined,
    jobSiteIds,
    contractId: typeof meta.contract_id === 'string' ? meta.contract_id : undefined,
    contractIds,
  };
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Sync state whenever the session changes.
  const handleSession = useCallback((s: Session | null) => {
    setSession(s);
    setProfile(s?.user ? profileFromUser(s.user) : null);
  }, []);

  useEffect(() => {
    // Load the current session on mount.
    supabase.auth.getSession().then(({ data }) => {
      handleSession(data.session);
      setIsLoading(false);
    });

    // Subscribe to auth state changes (sign-in, sign-out, token refresh).
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => {
      handleSession(s);
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, [handleSession]);

  const signIn = useCallback(async (email: string, password: string) => {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (!data.session) {
      throw new Error('Unexpected response: sign-in succeeded but no session was returned.');
    }
    handleSession(data.session);
  }, [handleSession]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  return (
    <AuthContext.Provider value={{ session, profile, isLoading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/** Consume the auth context. Must be used inside <AuthProvider>. */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an <AuthProvider>');
  }
  return ctx;
}

/** Auth capabilities for a user profile. */
export interface AuthCapabilities {
  canWrite: boolean;
  canOperate: boolean;
  role: AppRole | undefined;
}

/**
 * Returns the current user's auth capabilities without throwing when called
 * outside an <AuthProvider>. Defaults to the most restrictive set
 * (canWrite: false, canOperate: false) when no session is available.
 * The returned object is memoized — its reference is stable as long as the
 * user's role does not change.
 */
export function useAuthCapabilities(): AuthCapabilities {
  const ctx = useContext(AuthContext);
  const role = ctx?.profile?.role;
  return useMemo<AuthCapabilities>(
    () => ({
      canWrite: canWrite(role),
      canOperate: canOperate(role),
      role,
    }),
    [role]
  );
}
