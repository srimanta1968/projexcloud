'use client';

import { FormEvent, useState } from 'react';
import { Button } from './Button';
import { Field } from './Field';
import { Input } from './Input';
import { SESSION_COOKIE } from '../auth/session';

const DEFAULT_API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3500';
const SESSION_MAX_AGE = 60 * 60 * 24 * 7; // 7 days, matches JWT_EXPIRES_IN default

export interface AdminLoginFormProps {
  /** Gateway base URL. Defaults to NEXT_PUBLIC_API_BASE or http://localhost:3500. */
  apiBase?: string;
  /** Path to return to after a successful sign-in. Defaults to '/'. */
  returnTo?: string;
}

/**
 * Self-contained email + password sign-in for the admin consoles (which have no
 * app-level apiClient). POSTs to /api/auth/login, writes the JWT into the
 * `projexlight.session` cookie that the portal middleware reads, then navigates
 * to returnTo. Used by the tenant-admin and projexcloud-admin /login pages.
 */
export function AdminLoginForm({ apiBase = DEFAULT_API_BASE, returnTo }: AdminLoginFormProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`${apiBase}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = (await res.json().catch(() => null)) as
        | { data?: { token?: string }; error?: string }
        | null;
      if (!res.ok || !json?.data?.token) {
        setError(res.status === 401 ? 'Incorrect email or password.' : json?.error ?? 'Sign-in failed. Please try again.');
        return;
      }
      // Set the cookie the edge middleware reads, then navigate.
      document.cookie = `${SESSION_COOKIE}=${json.data.token}; path=/; SameSite=Lax; max-age=${SESSION_MAX_AGE}`;
      const dest = returnTo && returnTo.startsWith('/') ? returnTo : '/';
      window.location.assign(dest);
    } catch {
      setError('Sign-in failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
      <Field label="Email" htmlFor="login-email">
        <Input
          id="login-email"
          // A form input with no `name` is addressable only by id. That breaks native form
          // submission, password managers, and any tool that locates fields by name — which
          // is how the BDD runner looks them up, so every auth-gated scenario silently sat on
          // /login: it found no field, filled nothing, and never submitted.
          name="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>

      <Field label="Password" htmlFor="login-password">
        <Input
          id="login-password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
