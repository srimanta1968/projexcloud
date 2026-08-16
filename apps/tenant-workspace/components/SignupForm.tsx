'use client';

import { FormEvent, useState } from 'react';
import { Button, EmailField, Field, Input, Select } from '@projexlight/design-system';
import { signupTenant, type SignupTenantResponse } from '../services/authApi';

export interface SignupFormProps {
  onSuccess?: (result: SignupTenantResponse) => void;
}

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
    <form onSubmit={handleSubmit} aria-label="Sign up" className="flex max-w-md flex-col gap-3.5">
      {/* Checked here for the same reason as /register: the verification link
          that completes this signup is sent to this address. */}
      <EmailField id="signup-email" label="Work email" required autoComplete="email"
        value={email} onChange={setEmail} />

      <Field label="Password" htmlFor="signup-password" hint="Minimum 8 characters.">
        <Input id="signup-password" type="password" required minLength={8} autoComplete="new-password"
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>

      <Field label="Confirm password" htmlFor="signup-confirm">
        <Input id="signup-confirm" type="password" required autoComplete="new-password"
          value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>

      <Field
        label="Company name"
        htmlFor="signup-company"
        hint={<>We&apos;ll create a workspace called &ldquo;<em>{companyName || 'Your company'}</em>&rdquo; and make you its admin.</>}
      >
        <Input id="signup-company" type="text" required maxLength={80} placeholder="Acme Corp"
          value={companyName} onChange={(e) => setCompanyName(e.target.value)} />
      </Field>

      <Field label="Region" htmlFor="signup-region" hint="Data residency stays in this region.">
        <Select id="signup-region" value={region} onChange={(e) => setRegion(e.target.value)}>
          <option value="us-east-1">US East (N. Virginia)</option>
          <option value="us-west-2">US West (Oregon)</option>
          <option value="eu-west-1">EU (Ireland)</option>
          <option value="eu-central-1">EU (Frankfurt)</option>
          <option value="ap-southeast-1">Asia Pacific (Singapore)</option>
        </Select>
      </Field>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <Button type="submit" disabled={submitting}>
        {submitting ? 'Creating workspace…' : 'Create workspace'}
      </Button>

      <p className="text-xs text-muted-foreground">
        By signing up you accept the trial Terms of Service. Your workspace starts on the
        free trial plan; you can upgrade or close it any time.
      </p>
    </form>
  );
}
