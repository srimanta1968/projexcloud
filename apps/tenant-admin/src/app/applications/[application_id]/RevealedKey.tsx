'use client';

import { useEffect, useState } from 'react';
import { Alert, Button } from '@projexlight/design-system';

/**
 * The one-time reveal.
 *
 * The plaintext arrives as a search param and is shown once. Two things happen
 * on mount, both deliberate:
 *
 *  1. the param is stripped from the address bar with `replaceState`, so the
 *     credential does not sit in the URL, in browser history, or in a link the
 *     operator might paste into a ticket while showing someone the problem;
 *  2. nothing writes it anywhere. The previous implementation put it in a
 *     non-httpOnly cookie — readable by any script on the origin, and still
 *     there a minute later. A value that exists only in this component's state
 *     is gone the moment the operator navigates, which is exactly the promise
 *     the copy is making.
 */
export function RevealedKey({
  plaintext,
  rotated,
  graceHours,
}: {
  plaintext: string;
  rotated: boolean;
  graceHours: number;
}): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('issued');
    url.searchParams.delete('rotated');
    window.history.replaceState({}, '', url.toString());
  }, []);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(plaintext);
      setCopied(true);
    } catch {
      // Clipboard access can be refused (insecure origin, permission policy).
      // Reveal the value instead of failing silently — the operator can still
      // select it by hand, and a silent no-op would look like the copy worked.
      setShown(true);
    }
  }

  return (
    <Alert variant="success" className="mb-6">
      <strong>
        {rotated ? 'Rotated. Save the new key now' : 'Save this key now'} — it will not be shown again.
      </strong>
      <p className="mt-1 text-sm">
        Only a one-way hash is stored. If this value is lost, the only remedy is to rotate the key
        and update whatever was using it.
      </p>

      {shown ? (
        <div className="mt-2 select-all break-all rounded bg-background/60 p-2 font-mono text-sm">
          {plaintext}
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-3">
          <code className="rounded bg-background/60 px-2 py-1 font-mono text-sm">
            {plaintext.slice(0, 12)}
            {'…'}
            {plaintext.slice(-4)}
          </code>
          <Button type="button" size="sm" onClick={copy}>
            {copied ? 'Copied' : 'Copy full key'}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setShown(true)}>
            Reveal
          </Button>
        </div>
      )}

      {rotated && (
        <p className="mt-3 text-sm">
          The previous key keeps working for {graceHours} hours so you can deploy this one first.
          Once traffic has moved — check <em>last used</em> in the table below — revoke the old key.
          Skipping that last step leaves a live credential in the wild when the window closes.
        </p>
      )}
    </Alert>
  );
}
