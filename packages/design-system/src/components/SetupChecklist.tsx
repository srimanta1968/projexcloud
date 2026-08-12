import * as React from 'react';
import { cn } from '../lib/cn';

/**
 * Prefix a root-relative href with the portal's basePath.
 *
 * next/link does this automatically; a plain <a> does not, and this package is
 * framework-agnostic so it cannot use next/link. Without it, every CTA rendered
 * here points outside the portal — see the note at the call site.
 *
 * NEXT_PUBLIC_* is inlined at build time by Next, so this reads correctly in
 * both server and client components. Absolute URLs, protocol-relative URLs and
 * pure anchors are returned untouched; so is an href that already carries the
 * prefix, which keeps this safe to apply twice.
 */
function withBasePath(href: string): string {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  if (!base) return href;
  if (!href.startsWith('/') || href.startsWith('//')) return href;
  if (href === base || href.startsWith(`${base}/`)) return href;
  return `${base}${href}`;
}

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
                    /*
                     * basePath MUST BE APPLIED BY HAND HERE.
                     *
                     * This is a plain <a>, not a next/link <Link>, because this
                     * package is framework-agnostic and cannot import next/link.
                     * Next only rewrites hrefs for <Link>, so a root-relative
                     * href written here escapes the portal entirely: on the
                     * console, href="/config" resolves to
                     * https://cloud.projexlight.com/config, which is not a portal
                     * route at all — it reaches the api-gateway, whose
                     * default-deny gate answers
                     * {"error":"Unauthorized","details":["Missing bearer token"]}.
                     *
                     * That is precisely what every "Set up →" button did: the
                     * operator clicked a setup step and got a raw auth error from
                     * a different service, which reads as "I am not logged in"
                     * rather than "this link is wrong".
                     *
                     * Only root-relative hrefs are prefixed; absolute URLs and
                     * anchors are passed through untouched.
                     */
                    href={withBasePath(s.href)}
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
