'use client';

import { FormEvent, useState } from 'react';
import { registerUser } from '../services/authApi';

export interface RegisterFormProps {
  onSuccess?: (userId: string, email: string) => void;
}

const FIELD: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 };
const INPUT: React.CSSProperties = { padding: '8px 10px', border: '1px solid #d7dce4', borderRadius: 6, fontSize: 14 };

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
      const e = err as { error?: string; details?: string[] };
      const msg = e.details?.join(', ') || e.error || 'Registration failed.';
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} aria-label="Register">
      <label style={FIELD} htmlFor="register-email">
        <span><strong>Email</strong></span>
        <input
          id="register-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          style={INPUT}
        />
      </label>

      <label style={FIELD} htmlFor="register-password">
        <span><strong>Password</strong></span>
        <input
          id="register-password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
          style={INPUT}
        />
        <small style={{ color: '#7a8597' }}>Minimum 8 characters.</small>
      </label>

      <label style={FIELD} htmlFor="register-confirm">
        <span><strong>Confirm password</strong></span>
        <input
          id="register-confirm"
          type="password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
          autoComplete="new-password"
          style={INPUT}
        />
      </label>

      {error && (
        <p role="alert" style={{ color: '#c12f1c', fontSize: 14, marginBottom: 12 }}>{error}</p>
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
        {submitting ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  );
}
