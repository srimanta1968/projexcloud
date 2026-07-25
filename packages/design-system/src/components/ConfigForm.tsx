'use client';

import * as React from 'react';
import { Card } from './Card';
import { Button } from './Button';
import { Field } from './Field';
import { Input } from './Input';
import { cn } from '../lib/cn';

/**
 * A single configurable setting rendered by ConfigForm. `kind='secret'` stores a
 * pointer (secret_ref) and shows only last4; `kind='value'` stores a non-secret
 * JSON object built from `fields` (defaults to a single `value` field).
 */
export interface ConfigEntry {
  key: string;
  label: string;
  description?: string;
  kind?: 'value' | 'secret';
  fields?: { name: string; label: string; placeholder?: string; secret?: boolean }[];
  /** Whether a value is currently set at this scope (drives the status badge). */
  configured?: boolean;
  /** For secrets: last 4 of the stored value, for a "•••• 1234" hint. */
  last4?: string;
  /** Current non-secret value, to prefill the form. */
  currentValue?: Record<string, unknown> | null;
}

export interface ConfigFormProps {
  scope: string;
  entries: ConfigEntry[];
  /** Persist a value/secret for a key. */
  onSave: (
    key: string,
    payload: { value?: Record<string, unknown>; secret_ref?: string },
  ) => Promise<{ ok: boolean; error?: string }>;
  /** Optional: remove (revoke) a key's value. */
  onRevoke?: (key: string) => Promise<{ ok: boolean; error?: string }>;
}

/**
 * Reusable scoped-config editor (EP-341, TK-3796). One card per setting with its
 * current status, an inline edit form, and (optionally) a Remove action. Portal-
 * agnostic: the caller supplies onSave/onRevoke wired to its own auth (server
 * action or client apiClient), so the SAME component powers the platform,
 * tenant, app and app-user config surfaces across all three portals.
 */
export function ConfigForm({ scope, entries, onSave, onRevoke }: ConfigFormProps) {
  return (
    <div className="space-y-4" data-scope={scope}>
      {entries.map((e) => (
        <ConfigCard key={e.key} entry={e} onSave={onSave} onRevoke={onRevoke} />
      ))}
    </div>
  );
}

function ConfigCard({
  entry,
  onSave,
  onRevoke,
}: {
  entry: ConfigEntry;
  onSave: ConfigFormProps['onSave'];
  onRevoke: ConfigFormProps['onRevoke'];
}) {
  const fields = React.useMemo(
    () =>
      entry.fields ?? [{ name: 'value', label: 'Value', secret: entry.kind === 'secret' }],
    [entry.fields, entry.kind],
  );
  const initial = React.useMemo(() => {
    const s: Record<string, string> = {};
    for (const f of fields) {
      const v = entry.currentValue?.[f.name];
      s[f.name] = v == null ? '' : String(v);
    }
    return s;
  }, [fields, entry.currentValue]);

  const [values, setValues] = React.useState<Record<string, string>>(initial);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setMsg(null);
    let payload: { value?: Record<string, unknown>; secret_ref?: string };
    if (entry.kind === 'secret') {
      const raw = values[fields[0].name]?.trim();
      if (!raw) {
        setBusy(false);
        setMsg({ type: 'err', text: 'Enter a value.' });
        return;
      }
      payload = { secret_ref: raw };
    } else {
      const value: Record<string, unknown> = {};
      for (const f of fields) {
        const v = values[f.name]?.trim();
        if (v) value[f.name] = v;
      }
      payload = { value };
    }
    const r = await onSave(entry.key, payload);
    setBusy(false);
    setMsg(r.ok ? { type: 'ok', text: 'Saved.' } : { type: 'err', text: r.error ?? 'Save failed.' });
  }

  async function revoke() {
    if (!onRevoke) return;
    setBusy(true);
    setMsg(null);
    const r = await onRevoke(entry.key);
    setBusy(false);
    if (r.ok) {
      setValues(Object.fromEntries(fields.map((f) => [f.name, ''])));
      setMsg({ type: 'ok', text: 'Removed.' });
    } else {
      setMsg({ type: 'err', text: r.error ?? 'Remove failed.' });
    }
  }

  return (
    <Card className="p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold">{entry.label}</h3>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-medium',
                entry.configured
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {entry.configured ? 'Configured' : 'Not configured'}
            </span>
          </div>
          {entry.description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{entry.description}</p>
          ) : null}
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">{entry.key}</p>
        </div>
        {entry.kind === 'secret' && entry.last4 ? (
          <span className="shrink-0 font-mono text-xs text-muted-foreground">•••• {entry.last4}</span>
        ) : null}
      </div>

      <form onSubmit={submit} className="space-y-3">
        {fields.map((f) => (
          <Field key={f.name} label={f.label} htmlFor={`${entry.key}-${f.name}`}>
            <Input
              id={`${entry.key}-${f.name}`}
              name={f.name}
              type={f.secret ? 'password' : 'text'}
              placeholder={f.placeholder}
              value={values[f.name] ?? ''}
              onChange={(e) => setValues((s) => ({ ...s, [f.name]: e.target.value }))}
              autoComplete="off"
            />
          </Field>
        ))}
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? 'Saving…' : entry.configured ? 'Update' : 'Save'}
          </Button>
          {entry.configured && onRevoke ? (
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={revoke}>
              Remove
            </Button>
          ) : null}
          {msg ? (
            <span
              className={cn(
                'text-xs',
                msg.type === 'ok' ? 'text-primary' : 'text-destructive',
              )}
            >
              {msg.text}
            </span>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
