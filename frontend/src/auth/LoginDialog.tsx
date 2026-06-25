/**
 * LoginDialog — email/password sign-in dialog.
 */

import { useState } from 'react';
import { LogIn, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from './AuthContext';

export function LoginDialog() {
  const { signIn } = useAuth();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await signIn(email, password);
      setOpen(false);
      setEmail('');
      setPassword('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign-in failed. Please check your credentials.');
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="sign-in-button">
          <LogIn className="h-4 w-4 mr-2" aria-hidden="true" />
          Sign In
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Sign in to Dealernet</DialogTitle>
          <DialogDescription>
            Enter your email and password to access the rental platform.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4 mt-2">
          <div className="space-y-2">
            <Label htmlFor="login-email">Email</Label>
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
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={isLoading}
              data-testid="login-password"
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive" data-testid="login-error">
              {error}
            </p>
          )}
          <Button type="submit" className="w-full" disabled={isLoading} data-testid="login-submit">
            {isLoading ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" aria-hidden="true" />
                Signing in…
              </>
            ) : (
              'Sign In'
            )}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
