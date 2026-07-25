import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * A single onboarding step shown on a portal dashboard. `done` drives the
 * green ✓ vs the numbered "to do" state; when not done and an `href` is given a
 * one-click CTA takes the user straight to where they fix it.
 */
export interface SetupStep {
  label: string;
  description?: string;
  done: boolean;
  href?: string;
  cta?: string;
}

/**
 * "Next steps" onboarding panel (EP-341). Rendered on each portal's dashboard so
 * a just-logged-in user immediately sees what they still need to configure and
 * can jump straight to it. Server-component-safe (no client hooks) — it is pure
 * presentation driven by the caller's resolveConfig-derived status.
 */
export function SetupChecklist({
  title = 'Next steps',
  subtitle,
  steps,
  className,
}: {
  title?: string;
  subtitle?: string;
  steps: SetupStep[];
  className?: string;
}) {
  const remaining = steps.filter((s) => !s.done).length;
  return (
    <div className={cn('rounded-lg border bg-card text-card-foreground p-5 shadow-sm', className)}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">{title}</h2>
        <span
          className={cn(
            'shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium',
            remaining === 0 ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          {remaining === 0 ? 'All set ✓' : `${remaining} step${remaining === 1 ? '' : 's'} left`}
        </span>
      </div>
      {subtitle ? <p className="mb-3 text-sm text-muted-foreground">{subtitle}</p> : <div className="mb-3" />}
      <ol className="space-y-2">
        {steps.map((s, i) => (
          <li
            key={s.label}
            className="flex items-start gap-3 rounded-md border bg-background p-3"
          >
            <span
              className={cn(
                'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                s.done
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-input bg-muted text-muted-foreground',
              )}
              aria-hidden
            >
              {s.done ? '✓' : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span className={cn('text-sm font-medium', s.done && 'text-muted-foreground')}>
                  {s.label}
                </span>
                {s.done ? (
                  <span className="shrink-0 text-xs font-medium text-primary">Configured</span>
                ) : s.href ? (
                  <a
                    href={s.href}
                    className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                  >
                    {s.cta ?? 'Set up →'}
                  </a>
                ) : (
                  <span className="shrink-0 text-xs text-muted-foreground">Action needed</span>
                )}
              </div>
              {s.description ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{s.description}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
