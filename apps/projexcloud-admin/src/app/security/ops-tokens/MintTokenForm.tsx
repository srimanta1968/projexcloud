'use client';

import { useFormState, useFormStatus } from 'react-dom';
import { Button, Field, Input } from '@projexlight/design-system';
import { mintOpsTokenAction, type MintResult } from './actions';

function SubmitButton(): JSX.Element {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? 'Minting…' : 'Mint token'}
    </Button>
  );
}

/**
 * Client form so the freshly-minted plaintext token can be shown ONCE (returned
 * from the server action via useFormState) without ever putting the secret in a
 * URL or persisting it. The secret is not recoverable after leaving this page.
 */
export function MintTokenForm(): JSX.Element {
  const [state, action] = useFormState<MintResult | null, FormData>(mintOpsTokenAction, null);

  return (
    <div className="rounded-lg border p-4">
      <h2 className="mb-3 text-sm font-semibold">Mint a new token</h2>
      <form action={action} className="flex flex-col gap-3">
        <Field
          label="Label"
          htmlFor="label"
          hint="How this token is identified in the list and audit log, e.g. qa-iceberg-tests."
        >
          <Input id="label" name="label" required placeholder="qa-iceberg-tests" />
        </Field>
        <Field
          label="Valid for (hours)"
          htmlFor="valid_hours"
          hint="How long the token works for testing — auto-expires after this many hours. Leave blank for no expiry. e.g. 8 = one workday."
        >
          <Input
            id="valid_hours"
            name="valid_hours"
            type="number"
            min="0"
            step="0.5"
            placeholder="8"
            defaultValue="8"
          />
        </Field>
        <Field
          label="Email token to QA user (optional)"
          htmlFor="deliver_to"
          hint="If set, the token and its validity window are emailed to this address after minting."
        >
          <Input id="deliver_to" name="deliver_to" type="email" placeholder="qa.user@example.com" />
        </Field>
        <Field label="Reason (optional)" htmlFor="reason">
          <Input id="reason" name="reason" placeholder="QA admin API testing" />
        </Field>
        <div>
          <SubmitButton />
        </div>
      </form>

      {state?.error && <p className="mt-3 text-sm text-destructive">{state.error}</p>}

      {state?.ok && state.token && (
        <div className="mt-4 rounded-md border border-amber-400 bg-amber-50 p-3">
          <p className="text-sm font-medium">
            Token <code>{state.label}</code> minted — valid for {state.durationLabel}
            {state.expires_at ? ` (expires ${new Date(state.expires_at).toLocaleString()})` : ''}.
          </p>
          {state.emailedTo && (
            <p className="mt-1 text-sm text-green-700">✓ Emailed to {state.emailedTo}.</p>
          )}
          {state.emailError && (
            <p className="mt-1 text-sm text-destructive">
              Could not email the token: {state.emailError} (copy it below and send it manually).
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">
            Copy it now — it is shown once and cannot be recovered. Give it to QA as the
            <code> x-admin-ops-token</code> header value.
          </p>
          <code className="mt-2 block break-all rounded bg-background p-2 font-mono text-xs">
            {state.token}
          </code>
        </div>
      )}
    </div>
  );
}
