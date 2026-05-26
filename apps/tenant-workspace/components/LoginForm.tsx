'use client';

import { FormEvent, useState } from 'react';
import { loginUser, type LoginResponse } from '../services/authApi';

export interface LoginFormProps {
  onSuccess?: (result: LoginResponse) => void;
}

const FIELD: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 };
const INPUT: React.CSSProperties = { padding: '8px 10px', border: '1px solid #d7dce4', borderRadius: 6, fontSize: 14 };

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
    <form onSubmit={handleSubmit}>
      <label style={FIELD}>
        <span>Email</span>
        <input
          style={INPUT} type="email" required autoComplete="email"
          value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>

      <label style={FIELD}>
        <span>Password</span>
        <input
          style={INPUT} type="password" required autoComplete="current-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>

      {error && (
        <div style={{ color: '#b00020', fontSize: 13, marginBottom: 12 }}>{error}</div>
      )}

      <button
        type="submit"
        disabled={submitting}
        style={{
          background: submitting ? '#5a6573' : '#0b1220',
          color: '#fff',
          padding: '10px 20px',
          borderRadius: 6,
          border: 'none',
          fontSize: 15,
          fontWeight: 600,
          cursor: submitting ? 'wait' : 'pointer',
          width: '100%',
        }}
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
