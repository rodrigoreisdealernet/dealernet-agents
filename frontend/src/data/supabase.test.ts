import { describe, expect, it } from 'vitest';
import { resolveSupabaseConfig } from './supabase';

describe('resolveSupabaseConfig', () => {
  it('prefers runtime config values when present', () => {
    expect(
      resolveSupabaseConfig(
        {
          VITE_SUPABASE_URL: 'https://runtime.example.com',
          VITE_SUPABASE_ANON_KEY: 'runtime-anon',
        },
        {
          VITE_SUPABASE_URL: 'https://vite.example.com',
          VITE_SUPABASE_ANON_KEY: 'vite-anon',
        }
      )
    ).toEqual({
      supabaseUrl: 'https://runtime.example.com',
      supabaseAnonKey: 'runtime-anon',
    });
  });

  it('falls back to vite env and then local defaults', () => {
    expect(
      resolveSupabaseConfig(
        {},
        {
          VITE_SUPABASE_URL: 'https://vite.example.com',
          VITE_SUPABASE_ANON_KEY: 'vite-anon',
        }
      )
    ).toEqual({
      supabaseUrl: 'https://vite.example.com',
      supabaseAnonKey: 'vite-anon',
    });

    expect(resolveSupabaseConfig({}, {})).toEqual({
      supabaseUrl: 'http://localhost:55432',
      supabaseAnonKey: 'dev-anon-key',
    });
  });
});
