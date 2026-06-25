/**
 * Supabase Client Setup
 */

import { createClient } from '@supabase/supabase-js';

type RuntimeConfig = Partial<{
  VITE_SUPABASE_URL: string;
  VITE_SUPABASE_ANON_KEY: string;
}>;

declare global {
  interface Window {
    __DIA_RUNTIME_CONFIG__?: RuntimeConfig;
  }
}

export function resolveSupabaseConfig(
  runtimeConfig: RuntimeConfig | undefined = window.__DIA_RUNTIME_CONFIG__,
  viteEnv: RuntimeConfig = import.meta.env as RuntimeConfig
) {
  return {
    supabaseUrl: runtimeConfig?.VITE_SUPABASE_URL || viteEnv.VITE_SUPABASE_URL || 'http://localhost:55432',
    supabaseAnonKey: runtimeConfig?.VITE_SUPABASE_ANON_KEY || viteEnv.VITE_SUPABASE_ANON_KEY || 'dev-anon-key',
  };
}

const { supabaseUrl, supabaseAnonKey } = resolveSupabaseConfig();

/**
 * Supabase client singleton
 */
export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});

/**
 * Typed Supabase client type
 */
export type SupabaseClient = typeof supabase;
