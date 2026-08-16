'use client';

import * as React from 'react';
import { Field } from './Field';
import { Input } from './Input';
import { cn } from '../lib/cn';

/**
 * An email input that says whether the address can actually receive mail.
 *
 * WHY THIS IS SHARED RATHER THAN WRITTEN PER PORTAL. Three portals take an
 * address that something will later be sent to — a sign-up, a sender identity,
 * an invitation — and the cost of a wrong one differs on each. Written three
 * times they would drift on the only decision that matters: which verdicts are
 * worth interrupting somebody for.
 *
 * IT NEVER BLOCKS SUBMISSION, and that is deliberate. The server decides what
 * may be sent (sdk-deliverability's sendDecision), and it refuses only what is
 * proven undeliverable. A form that disabled its own submit button on `risky`
 * would refuse addresses the server accepts, and one that did so on `unknown`
 * would refuse real customers every time our resolver had a bad minute.
 *
 * ON BLUR, NOT ON EVERY KEYSTROKE. "ada@g" is not an address anybody meant, and
 * checking it spends a DNS query to tell somebody mid-word that their half-typed
 * domain does not exist.
 */

const DEFAULT_API_BASE = process.env.NEXT_PUBLIC_API_BASE || 'http://localhost:3500';

export type EmailVerdict = 'deliverable' | 'undeliverable' | 'risky' | 'unknown';

export interface EmailVerification {
  address: string;
  domain: string;
  verdict: EmailVerdict;
  code: string;
  reason: string;
  mail_exchangers: string[];
  did_you_mean: string | null;
  allowed: boolean;
}

export interface EmailFieldProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  /** Gateway base URL. Defaults to NEXT_PUBLIC_API_BASE. */
  apiBase?: string;
  /** Bearer token, when the portal holds a session. */
  token?: string | null;
  hint?: string;
  /** Told about every verdict, so a caller can gate its own submit if it must. */
  onVerified?: (verification: EmailVerification | null) => void;
}

const TONE: Record<EmailVerdict, string> = {
  undeliverable: 'text-destructive',
  risky: 'text-amber-600',
  deliverable: 'text-emerald-600',
  unknown: 'text-muted-foreground',
};

export function EmailField({
  label = 'Email',
  value,
  onChange,
  apiBase = DEFAULT_API_BASE,
  token,
  hint,
  onVerified,
  id = 'email',
  ...rest
}: EmailFieldProps): JSX.Element {
  const [verification, setVerification] = React.useState<EmailVerification | null>(null);
  const [checking, setChecking] = React.useState(false);
  // What we last ASKED about, so a blur with an unchanged value costs nothing.
  const asked = React.useRef<string | null>(null);
  const inFlight = React.useRef<AbortController | null>(null);

  React.useEffect(() => () => inFlight.current?.abort(), []);

  const report = React.useCallback((v: EmailVerification | null) => {
    setVerification(v);
    onVerified?.(v);
  }, [onVerified]);

  const check = React.useCallback(async (raw: string): Promise<void> => {
    const address = raw.trim();
    if (address === '') { asked.current = null; report(null); return; }
    if (asked.current === address) return;
    asked.current = address;

    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setChecking(true);
    try {
      const res = await fetch(`${apiBase}/api/deliverability/address/verify`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ address }),
      });
      if (!res.ok) { asked.current = null; report(null); return; }
      const body = await res.json();
      report((body?.data?.results?.[0] as EmailVerification) ?? null);
    } catch {
      /* SILENT. This is advisory: if it cannot run, the form behaves exactly as
         it did before the check existed. Telling somebody "the address check
         failed" beside an email box describes our plumbing and gives them
         nothing to do about it. */
      asked.current = null;
      report(null);
    } finally {
      if (!controller.signal.aborted) setChecking(false);
    }
  }, [apiBase, token, report]);

  return (
    <Field label={label} htmlFor={id} hint={hint}>
      <Input
        {...rest}
        id={id}
        type="email"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={(e) => { void check(e.target.value); }}
        aria-invalid={verification?.verdict === 'undeliverable' || undefined}
      />
      {checking && (
        <p className="mt-1 text-xs text-muted-foreground">
          Checking whether that address can receive email…
        </p>
      )}
      {/* `unknown` renders NOTHING: it means our check could not run, which is
          not a fact about the address and not something the person can act on. */}
      {!checking && verification && verification.verdict !== 'unknown' && (
        <p
          className={cn('mt-1 text-xs', TONE[verification.verdict])}
          role={verification.verdict === 'undeliverable' ? 'alert' : undefined}
        >
          {verification.verdict === 'deliverable'
            ? `That address can receive email${verification.mail_exchangers[0] ? ` — ${verification.domain} is served by ${verification.mail_exchangers[0]}.` : '.'}`
            : verification.reason}
          {verification.did_you_mean && (
            <>
              {' '}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => { onChange(verification.did_you_mean as string); void check(verification.did_you_mean as string); }}
              >
                Use {verification.did_you_mean}
              </button>
            </>
          )}
        </p>
      )}
    </Field>
  );
}
