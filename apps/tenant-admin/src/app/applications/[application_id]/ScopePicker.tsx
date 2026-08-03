'use client';

import { useMemo, useState } from 'react';
import { Badge, Field, Input } from '@projexlight/design-system';

/**
 * Scope picker.
 *
 * The platform derives the scope a request needs from its own route
 * (`<domain>.<resource>.<action>`), so the set below mirrors that convention
 * rather than inventing a parallel vocabulary. Domain-level wildcards are
 * offered first because that is what most integrations actually want: a key
 * scoped to `sla.*` keeps working when a new SLA resource ships, where a key
 * pinned to today's resource list quietly starts 403ing instead.
 *
 * Free text is allowed alongside the checkboxes — the domain list here cannot
 * stay exhaustive across ~68 SDKs, and an operator who knows the scope they
 * need should not be blocked because this file is a release behind.
 */

interface Domain {
  domain: string;
  label: string;
  resources: string[];
}

const DOMAINS: Domain[] = [
  { domain: 'sla', label: 'SLA clocks & escalation', resources: ['clock', 'policy', 'calendar', 'breach-scan'] },
  { domain: 'assignment', label: 'Assignment & routing', resources: ['assign-by-task', 'workload'] },
  { domain: 'notification', label: 'Notifications', resources: ['send', 'template', 'preference'] },
  { domain: 'crm', label: 'CRM', resources: ['contact', 'deal', 'activity'] },
  { domain: 'coverage', label: 'Coverage & availability', resources: ['eligible', 'schedule', 'time-off'] },
  { domain: 'scheduling', label: 'Scheduling', resources: ['appointment', 'availability', 'meeting-type'] },
  { domain: 'import', label: 'Import', resources: ['run', 'template', 'preview'] },
  { domain: 'consent', label: 'Consent', resources: ['consent', 'receipt'] },
];

export function ScopePicker(): JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);
  const [custom, setCustom] = useState('');

  const customScopes = useMemo(
    () =>
      custom
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [custom],
  );

  const all = useMemo(
    () => Array.from(new Set([...selected, ...customScopes])),
    [selected, customScopes],
  );

  function toggle(scope: string): void {
    setSelected((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
  }

  return (
    <div className="grid gap-3">
      {/* The form posts these, not the checkboxes, so free text and selections
          arrive through one channel and cannot disagree. */}
      {all.map((scope) => (
        <input key={scope} type="hidden" name="scopes" value={scope} />
      ))}

      <Field
        label="Scopes"
        hint="Read is GET; write is everything else. A wildcard like sla.* covers resources added later."
      >
        <div className="grid gap-3 rounded-md border p-3">
          {DOMAINS.map((d) => (
            <div key={d.domain}>
              <div className="mb-1 flex items-center gap-2">
                <span className="text-sm font-medium">{d.label}</span>
                <button
                  type="button"
                  onClick={() => toggle(`${d.domain}.*`)}
                  className={`rounded border px-1.5 py-0.5 text-[11px] ${
                    selected.includes(`${d.domain}.*`)
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'text-muted-foreground'
                  }`}
                >
                  {d.domain}.* (everything)
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {d.resources.flatMap((resource) =>
                  (['read', 'write'] as const).map((action) => {
                    const scope = `${d.domain}.${resource}.${action}`;
                    const on = selected.includes(scope);
                    return (
                      <button
                        key={scope}
                        type="button"
                        onClick={() => toggle(scope)}
                        className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                          on ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground'
                        }`}
                      >
                        {resource}.{action}
                      </button>
                    );
                  }),
                )}
              </div>
            </div>
          ))}
        </div>
      </Field>

      <Field
        label="Other scopes"
        htmlFor="custom-scopes"
        hint="Space or comma separated. Call the endpoint you need without a scope and the 403 names the exact one it wants."
      >
        <Input
          id="custom-scopes"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="lead-scoring.score.read, evidence.capture.write"
        />
      </Field>

      {all.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">This key will hold:</span>
          {all.map((s) => (
            <Badge key={s} variant="secondary" className="font-mono text-[11px]">
              {s}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}
