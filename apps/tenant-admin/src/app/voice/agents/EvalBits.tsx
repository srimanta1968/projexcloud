'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@projexlight/design-system';

/**
 * Evaluation-run bits shared by the agent builder and the run page (VA·E10 · TK-4518).
 * A run is queued, then a voice-runtime worker plays it; the page refreshes itself until it
 * has a verdict.
 */

export interface EvalRunSummary {
  eval_run_id: string;
  mode: 'reported' | 'sandbox' | 'evaluation';
  status: 'queued' | 'running' | 'completed' | 'error';
  passed: boolean | null;
  score: number | null;
}

/** Re-renders the server page every few seconds while `active` (a run is queued or running). */
export function AutoRefresh({ active, everyMs = 3000 }: { active: boolean; everyMs?: number }): null {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), everyMs);
    return () => clearInterval(t);
  }, [active, everyMs, router]);
  return null;
}

export function EvalStatus({ run, testId }: { run: EvalRunSummary | null | undefined; testId?: string }): React.JSX.Element {
  if (!run) return <Badge variant="outline" data-testid={testId}>not evaluated</Badge>;
  if (run.status === 'queued' || run.status === 'running') return <Badge variant="warning" data-testid={testId}>{run.status}…</Badge>;
  if (run.status === 'error') return <Badge variant="destructive" data-testid={testId}>could not run</Badge>;
  const pct = run.score === null ? '' : ` · ${Math.round(run.score * 100)}%`;
  return run.passed
    ? <Badge variant="success" data-testid={testId}>passed{pct}</Badge>
    : <Badge variant="destructive" data-testid={testId}>failed{pct}</Badge>;
}
