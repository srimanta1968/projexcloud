'use client';

import { useState, FormEvent, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, Textarea, cn } from '@projexlight/design-system';
import { getToken } from '../../lib/apiClient';
import { PROJEXLIGHT_URL } from '../../lib/portalLinks';

/**
 * /build — SDK composition planner (replaces the brittle blueprint matcher).
 *
 * Flow:
 *   1. Tenant types app description.
 *   2. Server hits /api/build/plan → Claude composes a plan from the full
 *      ~88-SDK catalog: which SDKs to use, what's custom work, optional
 *      clarifying questions, vertical pack + complexity classification.
 *   3. UI renders the plan as a checklist the tenant can review and iterate.
 *
 * Compared to the old /api/build/match flow: this works against ANY
 * description (not just the 6 hand-curated blueprints), and uses the LLM
 * gateway instead of naive keyword matching.
 */

type Phase = 'idle' | 'planning' | 'done' | 'error';

interface RecommendedSdk {
  name: string;
  why: string;
}

type VerticalPack = 'general' | 'healthcare' | 'finserv' | 'publicSector' | 'fieldService' | 'revops';
type Complexity = 'small' | 'medium' | 'large';

interface BuildPlan {
  summary: string;
  recommended_sdks: RecommendedSdk[];
  custom_work: string[];
  clarifying_questions: string[];
  vertical_pack: VerticalPack;
  complexity: Complexity;
}

interface RetrievalMeta {
  retriever: string;
  retrieved: number;
  candidates: number;
  foundation_injected: string[];
  dependency_added: string[];
}

interface PlanMeta {
  catalog_size: number;
  provider?: string;
  retrieval?: RetrievalMeta;
}

const PILL = 'border uppercase tracking-wide';

const PACK_BADGE: Record<VerticalPack, string> = {
  general: 'bg-blue-50 text-blue-700 border-blue-200',
  healthcare: 'bg-green-50 text-green-700 border-green-200',
  finserv: 'bg-amber-50 text-amber-700 border-amber-200',
  publicSector: 'bg-violet-50 text-violet-700 border-violet-200',
  fieldService: 'bg-orange-50 text-orange-700 border-orange-200',
  revops: 'bg-pink-50 text-pink-700 border-pink-200',
};

const COMPLEXITY_BADGE: Record<Complexity, string> = {
  small: 'bg-green-50 text-green-700 border-green-200',
  medium: 'bg-amber-50 text-amber-700 border-amber-200',
  large: 'bg-red-50 text-red-700 border-red-200',
};

const SOURCE_BADGE: Record<'foundation' | 'dependency', { label: string; cls: string }> = {
  foundation: { label: 'Foundation · AIM', cls: 'bg-violet-50 text-violet-700 border-violet-200' },
  dependency: { label: 'Prerequisite', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
};

/** Why a recommended SDK is in the plan, derived from the retrieval meta. */
function sdkSource(name: string, retrieval?: RetrievalMeta): 'foundation' | 'dependency' | null {
  if (!retrieval) return null;
  if (retrieval.foundation_injected.includes(name)) return 'foundation';
  if (retrieval.dependency_added.includes(name)) return 'dependency';
  return null;
}

export default function BuildPage(): JSX.Element {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [intent, setIntent] = useState('');
  const [plan, setPlan] = useState<BuildPlan | null>(null);
  const [meta, setMeta] = useState<PlanMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = getToken();
    if (!t) router.replace('/login');
  }, [router]);

  async function submitIntent(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!intent.trim()) return;
    setError(null);
    setPhase('planning');
    try {
      const res = await fetch('/api/build/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${getToken() ?? ''}` },
        body: JSON.stringify({ intent }),
      });
      const body = (await res.json()) as { plan?: BuildPlan; meta?: PlanMeta; error?: string };
      if (!res.ok) {
        setError(body.error ?? `plan failed: ${res.status}`);
        setPhase('error');
        return;
      }
      if (!body.plan) {
        setError('plan response was empty');
        setPhase('error');
        return;
      }
      setPlan(body.plan);
      setMeta(body.meta ?? null);
      setPhase('done');
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  }

  function reset(): void {
    setPhase('idle');
    setIntent('');
    setPlan(null);
    setError(null);
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Build with AI</h1>
        <Button variant="secondary" size="sm" onClick={() => router.push('/dashboard')}>← Dashboard</Button>
      </header>

      <p className="mb-6 max-w-2xl leading-relaxed text-muted-foreground">
        Describe the app you want to build. The planner semantically searches all{' '}
        {meta?.catalog_size ?? '88+'} SDKs in the ProjexCloud catalog, always
        includes the identity/AIM foundation (login, personas, tenancy,
        permissions) and any prerequisites, then tells you which SDKs to wire in
        and what you still need to write yourself. Works for any domain —
        accounting, dispatch, claims, CRM, anything composable from the catalog.
      </p>

      {(phase === 'idle' || phase === 'planning' || phase === 'error') && (
        <Card className="p-6">
          <form onSubmit={submitIntent}>
            <label className="mb-2 block text-[15px] font-semibold">What do you want to build?</label>
            <Textarea
              value={intent}
              onChange={(e) => setIntent(e.target.value)}
              disabled={phase === 'planning'}
              placeholder={'e.g. "A financial accounting app with chart of accounts, journal entries, AR/AP, and monthly close." Or: "Dispatch field technicians to repair appointments based on availability + skill." Or: "A patient portal where clinicians can review consent before sending care messages."'}
              rows={5}
              className="resize-y"
            />
            <div className="mt-3.5 flex items-center justify-between">
              <Button type="submit" disabled={phase === 'planning' || !intent.trim()}>
                {phase === 'planning' ? 'Composing plan…' : 'Generate plan →'}
              </Button>
              <span className="text-xs text-muted-foreground">
                Powered by {meta?.provider === 'openai' ? 'OpenAI' : meta?.provider === 'anthropic' ? 'Claude' : meta?.provider === 'local' ? 'Local LLM (on-host)' : 'OpenAI / Claude (auto-select)'} · audit logging coming in v2
              </span>
            </div>
          </form>
        </Card>
      )}

      {phase === 'planning' && (
        <Card className="mt-4 bg-muted p-5 text-sm text-muted-foreground">
          Scanning the {meta?.catalog_size ?? 88}-SDK catalog and composing your plan. Usually 10–25 seconds.
        </Card>
      )}

      {phase === 'done' && plan && (
        <>
          <Card className="mt-4 p-5">
            <div className="mb-3.5 flex flex-wrap gap-2">
              <Badge className={cn(PILL, PACK_BADGE[plan.vertical_pack] ?? PACK_BADGE.general)}>{plan.vertical_pack}</Badge>
              <Badge className={cn(PILL, COMPLEXITY_BADGE[plan.complexity] ?? COMPLEXITY_BADGE.medium)}>{plan.complexity}</Badge>
              <Badge variant="outline" className={cn(PILL, 'bg-muted text-muted-foreground')}>{plan.recommended_sdks.length} SDKs</Badge>
            </div>
            <p className="text-[15px] leading-relaxed">{plan.summary}</p>
          </Card>

          {meta?.retrieval && (
            <Card className="mt-4 bg-muted p-5 text-[13px] text-muted-foreground">
              <div className="mb-1.5 font-semibold text-foreground">How these were found</div>
              <div className="leading-relaxed">
                {meta.retrieval.retriever === 'embedding' ? 'Semantic search' : 'Keyword search'} over the{' '}
                {meta.catalog_size}-SDK catalog returned <b>{meta.retrieval.retrieved}</b> domain match
                {meta.retrieval.retrieved === 1 ? '' : 'es'}, then the planner added the foundation and
                prerequisite SDKs below — <b>{meta.retrieval.candidates}</b> candidates in total were
                considered before composing the plan.
                {meta.retrieval.foundation_injected.length > 0 && (
                  <div className="mt-2">
                    <Badge className={cn(PILL, SOURCE_BADGE.foundation.cls, 'mr-2')}>Foundation · AIM</Badge>
                    auto-included so you don&apos;t rebuild auth:{' '}
                    <code className="text-xs">{meta.retrieval.foundation_injected.join(', ')}</code>
                  </div>
                )}
                {meta.retrieval.dependency_added.length > 0 && (
                  <div className="mt-1.5">
                    <Badge className={cn(PILL, SOURCE_BADGE.dependency.cls, 'mr-2')}>Prerequisite</Badge>
                    pulled in via the SDK dependency graph:{' '}
                    <code className="text-xs">{meta.retrieval.dependency_added.join(', ')}</code>
                  </div>
                )}
              </div>
            </Card>
          )}

          <h2 className="mb-3 mt-7 text-xl font-semibold">
            Recommended SDKs <span className="text-sm font-normal text-muted-foreground">({plan.recommended_sdks.length})</span>
          </h2>
          <Card className="p-5">
            {plan.recommended_sdks.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                The planner did not recommend any SDKs — your app may be too custom to compose from the existing catalog. See the custom work section below.
              </div>
            ) : (
              <ul className="divide-y">
                {plan.recommended_sdks.map((sdk) => {
                  const src = sdkSource(sdk.name, meta?.retrieval);
                  return (
                    <li key={sdk.name} className="py-3 first:pt-0 last:pb-0">
                      <code className="font-mono text-sm font-semibold text-foreground">{sdk.name}</code>
                      {src && <Badge className={cn(PILL, SOURCE_BADGE[src].cls, 'ml-2')}>{SOURCE_BADGE[src].label}</Badge>}
                      <div className="mt-1 text-sm leading-relaxed text-muted-foreground">{sdk.why}</div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {plan.custom_work.length > 0 && (
            <>
              <h2 className="mb-3 mt-7 text-xl font-semibold">
                You&apos;ll need to build <span className="text-sm font-normal text-muted-foreground">({plan.custom_work.length})</span>
              </h2>
              <Card className="p-5">
                <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
                  {plan.custom_work.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              </Card>
            </>
          )}

          {plan.clarifying_questions.length > 0 && (
            <>
              <h2 className="mb-3 mt-7 text-xl font-semibold">Questions to refine the plan</h2>
              <Card className="p-5">
                <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed">
                  {plan.clarifying_questions.map((q, i) => <li key={i}>{q}</li>)}
                </ul>
                <p className="mt-3.5 text-[13px] text-muted-foreground">
                  Tip: answer these in the prompt and regenerate for a tighter plan.
                </p>
              </Card>
            </>
          )}

          <div className="mt-6 flex flex-wrap gap-2">
            <Button
              onClick={() => {
                // Hand off to ProjexLight: carry the plan + THIS ProjexCloud's origin so the
                // new project pre-fills useProjexCloudSdks + the base URL automatically. No
                // credentials are passed — the user authenticates with their own ProjexLight
                // account (no key custody).
                const origin = typeof window !== 'undefined' ? window.location.origin : 'https://cloud.projexlight.com';
                const handoff = { v: 1, description: intent, plan, projexCloudBaseUrl: origin, useProjexCloudSdks: true };
                const enc = encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(handoff)))));
                window.open(`${PROJEXLIGHT_URL}/dashboard?handoff=${enc}`, '_blank', 'noopener');
              }}
            >
              Create in ProjexLight ↗
            </Button>
            <Button variant="secondary" onClick={reset}>Plan another</Button>
            <Button variant="secondary" onClick={() => setPhase('idle')}>Edit prompt &amp; regenerate</Button>
            <Button
              variant="secondary"
              onClick={() => {
                const payload = JSON.stringify(plan, null, 2);
                navigator.clipboard.writeText(payload).catch(() => undefined);
              }}
            >
              Copy plan as JSON
            </Button>
          </div>
        </>
      )}

      {phase === 'error' && error && (
        <Card className="mt-4 border-destructive/40 bg-destructive/10 p-5">
          <div className="mb-1 font-semibold text-destructive">Plan failed</div>
          <div className="break-words text-sm">{error}</div>
          <p className="mt-2.5 text-[13px] text-muted-foreground">
            Common causes: <code>ANTHROPIC_API_KEY</code> not loaded in the dev server&apos;s env,
            request timeout, or rate limit. Try again or check the server logs.
          </p>
        </Card>
      )}
    </main>
  );
}
