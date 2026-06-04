'use client';

import { FormEvent, useState } from 'react';
import { Button, Field, Input } from '@projexlight/design-system';
import { loginUser, type LoginResponse } from '../services/authApi';

export interface LoginFormProps {
  onSuccess?: (result: LoginResponse) => void;
}

/**
 * Email + password sign-in. Six-layer JWT comes back tenant-scoped; we
 * stash it via setToken() so every subsequent apiPost attaches Authorization
 * automatically. Caller passes onSuccess to redirect or render a welcome view.
 */
export default function LoginForm({ onSuccess }: LoginFormProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const result = await loginUser({ email, password });
      onSuccess?.(result);
    } catch (err) {
      const e = err as { error?: string; status?: number };
      if (e.status === 401) setError('Incorrect email or password.');
      else setError(e.error ?? 'Sign-in failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
      <Field label="Email" htmlFor="login-email">
        <Input
          id="login-email" type="email" required autoComplete="email"
          value={email} onChange={(e) => setEmail(e.target.value)} />
      </Field>

      <Field label="Password" htmlFor="login-password">
        <Input
          id="login-password" type="password" required autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
