'use client';

import { FormEvent, useState } from 'react';
import { Button, EmailField, Field, Input } from '@projexlight/design-system';
import { registerUser } from '../services/authApi';

export interface RegisterFormProps {
  onSuccess?: (userId: string, email: string) => void;
}

/**
 * Register form: email + password + confirm. On submit it calls
 * registerUser(), which POSTs /api/auth/register and persists the JWT.
 */
export default function RegisterForm({ onSuccess }: RegisterFormProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    try {
      const result = await registerUser({ email, password });
      if (onSuccess) onSuccess(result.userId, result.email);
    } catch (err) {
      const e = err as { error?: string; code?: string; details?: string[]; did_you_mean?: string | null };
      /* The server refuses an address it could never deliver the link to. Its
         sentence already names the domain and the remedy, so it is shown as
         written rather than replaced with a generic failure. */
      if (e.code === 'EMAIL_UNDELIVERABLE') {
        setError(
          `${e.details?.join(', ') || 'That address cannot receive email.'}` +
          `${e.did_you_mean ? ` Did you mean ${e.did_you_mean}?` : ''}`,
        );
        return;
      }
      const msg = e.details?.join(', ') || e.error || 'Registration failed.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} aria-label="Register" className="flex flex-col gap-3.5">
      {/* The address is checked while the form is still open, because the link
          that completes this registration is sent to it: a dead domain means an
          account nobody can ever finish creating, and this is the last moment
          the person can still fix it. */}
      <EmailField
        id="register-email" label="Email" required autoComplete="email"
        value={email} onChange={setEmail} />

      <Field label="Password" htmlFor="register-password" hint="Minimum 8 characters.">
        <Input
          id="register-password" type="password" required minLength={8} autoComplete="new-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>

      <Field label="Confirm password" htmlFor="register-confirm">
        <Input
          id="register-confirm" type="password" required autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  );
}
