'use client';

import { FormEvent, useState } from 'react';
import { signupTenant, type SignupTenantResponse } from '../services/authApi';

export interface SignupFormProps {
  onSuccess?: (result: SignupTenantResponse) => void;
}

const FIELD: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 };
const INPUT: React.CSSProperties = { padding: '8px 10px', border: '1px solid #d7dce4', borderRadius: 6, fontSize: 14 };

/**
 * Self-serve signup: collects the person's credentials AND the company name
 * so the gateway can create a fully-scoped tenant in one transaction.
 */
export default function SignupForm({ onSuccess }: SignupFormProps): JSX.Element {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [region, setRegion] = useState('us-east-1');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);

    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (!companyName.trim()) { setError('Company name is required.'); return; }

    setSubmitting(true);
    try {
      const result = await signupTenant({
        email,
        password,
        company_name: companyName,
        region: region || undefined,
      });
      if (onSuccess) onSuccess(result);
    } catch (err) {
      const e = err as { error?: string; details?: string[] };
      setError(e.details?.join(', ') || e.error || 'Signup failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} aria-label="Sign up" style={{ maxWidth: 480 }}>
      <label style={FIELD}>
        <span><strong>Work email</strong></span>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
          required autoComplete="email" style={INPUT} />
      </label>

      <label style={FIELD}>
        <span><strong>Password</strong></span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          required minLength={8} autoComplete="new-password" style={INPUT} />
        <small style={{ color: '#7a8597' }}>Minimum 8 characters.</small>
      </label>

      <label style={FIELD}>
        <span><strong>Confirm password</strong></span>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
          required autoComplete="new-password" style={INPUT} />
      </label>

      <label style={FIELD}>
        <span><strong>Company name</strong></span>
        <input type="text" value={companyName} onChange={(e) => setCompanyName(e.target.value)}
          required maxLength={80} placeholder="Acme Corp" style={INPUT} />
        <small style={{ color: '#7a8597' }}>
          We'll create a workspace called "<em>{companyName || 'Your company'}</em>" and make you its admin.
        </small>
      </label>

      <label style={FIELD}>
        <span><strong>Region</strong></span>
        <select value={region} onChange={(e) => setRegion(e.target.value)} style={INPUT}>
          <option value="us-east-1">US East (N. Virginia)</option>
          <option value="us-west-2">US West (Oregon)</option>
          <option value="eu-west-1">EU (Ireland)</option>
          <option value="eu-central-1">EU (Frankfurt)</option>
          <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
        </select>
        <small style={{ color: '#7a8597' }}>Data residency stays in this region.</small>
      </label>

      {error && <p role="alert" style={{ color: '#c12f1c', fontSize: 14 }}>{error}</p>}

      <button type="submit" disabled={submitting} style={{
        background: '#0b1220', color: '#fff', padding: '10px 20px',
        borderRadius: 6, border: 'none', fontSize: 14, cursor: 'pointer',
        opacity: submitting ? 0.6 : 1,
      }}>
        {submitting ? 'Creating workspace…' : 'Create workspace'}
      </button>

      <p style={{ marginTop: 16, fontSize: 13, color: '#5a6573' }}>
        By signing up you accept the trial Terms of Service. Your workspace starts on the
        free trial plan; you can upgrade or close it any time.
      </p>
    </form>
  );
}
