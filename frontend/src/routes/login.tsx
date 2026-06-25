/**
 * Standalone login page — rendered WITHOUT the app chrome (no header/sidebar).
 * The root layout (see __root.tsx) renders a bare shell for `/login`, and an
 * unauthenticated visit to any protected route redirects here.
 *
 * Layout: split-brand desktop (left ink-teal panel + right form), stacked mobile.
 */
import { useState } from 'react';
import { createFileRoute, useNavigate, redirect } from '@tanstack/react-router';
import { LogIn, Loader2, Truck, Bot, BadgeCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/auth/AuthContext';
import { supabase } from '@/data/supabase';

const MAX_SESSION_POLL_ATTEMPTS = 8;
const SESSION_POLL_DELAY_MS = 100;

export const Route = createFileRoute('/login')({
  // Already signed in? Don't show the login page — go to the app.
  beforeLoad: async () => {
    const { data } = await supabase.auth.getSession();
    if (data.session) {
      throw redirect({ to: '/' });
    }
  },
  component: LoginPage,
});

const FEATURE_BULLETS = [
  { icon: Truck, label: 'Fleet & availability' },
  { icon: Bot, label: 'Agentic operations' },
  { icon: BadgeCheck, label: 'Finance & compliance' },
] as const;

export function LoginPage() {
  const { signIn } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function waitForActiveSession() {
    for (let attempt = 0; attempt < MAX_SESSION_POLL_ATTEMPTS; attempt += 1) {
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, SESSION_POLL_DELAY_MS));
    }
    return false;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await signIn(email, password);
      const hasSession = await waitForActiveSession();
      if (!hasSession) {
        throw new Error('Session initialization timed out after sign-in. Please refresh and try again.');
      }
      await navigate({ to: '/' });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Please check your credentials.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row" data-testid="login-card">
      {/* Brand panel — full-width compact header on mobile, ~45% left column on desktop */}
      <div
        className="flex shrink-0 flex-col justify-center px-8 py-8 md:w-[45%] md:min-h-screen md:py-16"
        style={{ background: 'linear-gradient(to bottom, #0C2D2E, #0A2425)' }}
        data-testid="login-brand-panel"
      >
        {/* Wordmark */}
        <p className="text-xs font-semibold uppercase tracking-widest text-white/50 mb-1">
          Dealernet
        </p>
        <h1 className="text-2xl font-semibold text-white leading-snug md:text-3xl">
          Equipment rental operations,<br className="hidden md:block" /> run by agents —<br className="hidden md:block" /> overseen by you.
        </h1>

        {/* Feature bullets — hidden on mobile compact header */}
        <ul className="mt-6 hidden space-y-3 md:flex md:flex-col" aria-label="Platform features">
          {FEATURE_BULLETS.map(({ icon: Icon, label }) => (
            <li key={label} className="flex items-center gap-3 text-white/80 text-sm">
              <Icon className="h-4 w-4 shrink-0 text-white/60" aria-hidden="true" />
              {label}
            </li>
          ))}
        </ul>
      </div>

      {/* Form panel — white, centered */}
      <div className="flex flex-1 items-center justify-center bg-white px-6 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8">
            <h2 className="text-xl font-semibold text-foreground">Sign in</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Enter your email and password to access the rental platform.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="login-email" className="text-sm font-medium">
                Email
              </Label>
              <Input
                id="login-email"
                type="email"
                placeholder="you@example.com"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading}
                data-testid="login-email"
                className="focus-visible:ring-primary"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="login-password" className="text-sm font-medium">
                Password
              </Label>
              <Input
                id="login-password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
                data-testid="login-password"
                className="focus-visible:ring-primary"
              />
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                data-testid="login-error"
              >
                {error}
              </div>
            )}

            <Button
              type="submit"
              className="w-full"
              style={{ boxShadow: 'var(--button-primary-shadow)' }}
              disabled={isLoading}
              data-testid="login-submit"
            >
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                  Signing in…
                </>
              ) : (
                <>
                  <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
                  Sign In
                </>
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
