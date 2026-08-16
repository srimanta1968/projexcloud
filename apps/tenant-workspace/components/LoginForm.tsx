'use client';

import { FormEvent, useState } from 'react';
import { Button, Field, Input } from '@projexlight/design-system';
import {
  loginUser,
  getVerificationStatus,
  sendVerificationEmail,
  type LoginResponse,
} from '../services/authApi';

export interface LoginFormProps {
  onSuccess?: (result: LoginResponse) => void;
}

/**
 * Email + password sign-in. Verification-first: before calling /api/auth/login
 * we check /api/auth/verification-status; if the email exists but is unverified
 * we stop and prompt the user to verify (with a resend button) rather than
 * signing them in. Verification is enforced entirely client-side here — the
 * login API itself is unchanged. On success the six-layer JWT is stashed via
 * setToken() so subsequent calls attach Authorization automatically.
 */
export default function LoginForm({ onSuccess }: LoginFormProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [needsVerify, setNeedsVerify] = useState(false);
  const [resendMsg, setResendMsg] = useState<string | null>(null);

  const handleResend = async (): Promise<void> => {
    setResendMsg(null);
    try {
      await sendVerificationEmail(undefined, email);
      setResendMsg(`Verification link sent to ${email}. Check your inbox (and spam).`);
    } catch {
      setResendMsg('Could not resend the verification email. Please try again.');
    }
  };

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    setNeedsVerify(false);
    setResendMsg(null);
    setSubmitting(true);
    try {
      // Verification-first gate (client-side): block sign-in for unverified emails.
      const status = await getVerificationStatus(email).catch(() => null);
      if (status?.exists && !status.verified) {
        setNeedsVerify(true);
        return;
      }
      const result = await loginUser({ email, password });
      onSuccess?.(result);
    } catch (err) {
      const e = err as { error?: string; code?: string; status?: number };
      /* The server enforces verification too when EMAIL_VERIFICATION_REQUIRED is
         on. It answers 403 with a distinct code rather than 401 precisely so
         this can offer "resend the link" instead of "check your password" — the
         credentials were right. The client-side check above is kept because it
         spares a round trip and still works when the server is not enforcing. */
      if (e.status === 403 && e.code === 'EMAIL_NOT_VERIFIED') {
        setNeedsVerify(true);
        return;
      }
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

      {needsVerify && (
        <div role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          <p className="mb-2 font-medium">Please verify your email first.</p>
          <p className="mb-2 text-muted-foreground">
            We need to confirm <strong className="text-foreground">{email}</strong> before you can sign in.
            Click the link in the verification email we sent.
          </p>
          <button
            type="button"
            onClick={handleResend}
            className="font-medium text-primary underline underline-offset-2"
          >
            Resend verification email
          </button>
          {resendMsg && <p className="mt-2 text-muted-foreground">{resendMsg}</p>}
        </div>
      )}

      <Button type="submit" disabled={submitting} className="w-full">
        {submitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
