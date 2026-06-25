/**
 * usePortalSession — lightweight hook for the customer-facing portal auth boundary.
 *
 * Resolves the current Supabase GoTrue session and determines whether the caller
 * has an active portal_customer session (as defined in ADR-0043).
 *
 * The hook is intentionally separate from the staff useAuth/AuthContext hook so
 * that portal routes never inherit operator roles or staff session state.
 */

import { useEffect, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/data/supabase';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PortalSession {
  /** Raw Supabase session, or null when unauthenticated. */
  session: Session | null;
  /** True when the session carries a portal_customer role claim. */
  isPortalCustomer: boolean;
  /** Customer id(s) from JWT claims for scope enforcement. */
  customerIds: string[];
  /** Auth user id from JWT sub. */
  userId: string | null;
  /** True while the initial session is being resolved. */
  isLoading: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    const t = value.trim();
    return t ? [t] : [];
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

export function extractPortalSessionFields(session: Session | null): Pick<PortalSession, 'isPortalCustomer' | 'customerIds' | 'userId'> {
  if (!session?.user) {
    return { isPortalCustomer: false, customerIds: [], userId: null };
  }

  const meta = (session.user.app_metadata ?? {}) as Record<string, unknown>;
  const role = typeof meta.role === 'string' ? meta.role : '';
  const isPortalCustomer = role === 'portal_customer';

  const customerIds = Array.from(
    new Set([
      ...readStringArray(meta.customer_id),
      ...readStringArray(meta.customer_ids),
    ])
  );

  return {
    isPortalCustomer,
    customerIds,
    userId: session.user.id ?? null,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePortalSession(): PortalSession {
  const [session, setSession] = useState<Session | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (!cancelled) {
        setSession(data.session);
        setIsLoading(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setSession(null);
        setIsLoading(false);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      if (!cancelled) {
        setSession(newSession);
      }
    });

    return () => {
      cancelled = true;
      listener.subscription.unsubscribe();
    };
  }, []);

  const fields = extractPortalSessionFields(session);

  return {
    session,
    isLoading,
    ...fields,
  };
}
