'use client';

import { useState, FormEvent, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getToken } from '../../lib/apiClient';

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

const SHELL: React.CSSProperties = { maxWidth: 920, margin: '0 auto', padding: '40px 24px', fontFamily: 'system-ui, sans-serif', color: '#1b2a44' };
const CARD: React.CSSProperties = { background: '#fff', border: '1px solid #d7dce4', borderRadius: 10, padding: 22, marginBottom: 16 };
const SOFT_CARD: React.CSSProperties = { ...CARD, background: '#f8fafd' };

const BADGE: React.CSSProperties = {
  display: 'inline-block', fontSize: 11, fontWeight: 600,
  padding: '3px 10px', borderRadius: 999, marginRight: 8,
  textTransform: 'uppercase', letterSpacing: '0.05em',
};

const PACK_COLORS: Record<VerticalPack, { bg: string; fg: string; border: string }> = {
  general:      { bg: '#ecf2fc', fg: '#1a4fc4', border: '#b9c3d6' },
  healthcare:   { bg: '#e8f5e9', fg: '#0d8a3d', border: '#9bcfa3' },
  finserv:      { bg: '#fdf6e3', fg: '#9a6e00', border: '#e3c47b' },
  publicSector: { bg: '#f3eafe', fg: '#5a2cb8', border: '#c9b3e8' },
  fieldService: { bg: '#fff0e6', fg: '#b35900', border: '#e8b884' },
  revops:       { bg: '#fde8f2', fg: '#a31872', border: '#e8a3c5' },
};

const COMPLEXITY_COLORS: Record<Complexity, { bg: string; fg: string; border: string }> = {
  small:  { bg: '#e8f5e9', fg: '#0d8a3d', border: '#9bcfa3' },
  medium: { bg: '#fdf6e3', fg: '#9a6e00', border: '#e3c47b' },
  large:  { bg: '#fdecea', fg: '#a31818', border: '#e8a3a3' },
};

export default function BuildPage(): JSX.Element {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [intent, setIntent] = useState('');
  const [plan, setPlan] = useState<BuildPlan | null>(null);
  const [meta, setMeta] = useState<{ catalog_size: number } | null>(null);
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
      const body = (await res.json()) as { plan?: BuildPlan; meta?: { catalog_size: number }; error?: string };
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
    <main style={SHELL}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 30, letterSpacing: '-0.01em' }}>Build with AI</h1>
        <button
          onClick={() => router.push('/dashboard')}
          style={{ background: '#f3f5f8', border: '1px solid #d7dce4', padding: '8px 16px', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: '#1b2a44' }}>
          ← Dashboard
        </button>
      </header>

      <p style={{ color: '#5a6573', marginBottom: 24, lineHeight: 1.6, maxWidth: 720 }}>
        Describe the app you want to build. The planner scans all{' '}
        {meta?.catalog_size ?? '88+'} SDKs in the ProjexCloud catalog and tells
        you which to wire in, what you still need to write yourself, and a few
        clarifying questions if your description is ambiguous. Works for any
        domain — accounting, dispatch, claims, CRM, anything composable from
        the catalog.
      </p>

      {(phase === 'idle' || phase === 'planning' || phase === 'error') && (
        <form onSubmit={submitIntent} style={CARD}>
          <label style={{ display: 'block', marginBottom: 8, fontWeight: 600, fontSize: 15 }}>
            What do you want to build?
          </label>
          <textarea
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            disabled={phase === 'planning'}
            placeholder={'e.g. "A financial accounting app with chart of accounts, journal entries, AR/AP, and monthly close." Or: "Dispatch field technicians to repair appointments based on availability + skill." Or: "A patient portal where clinicians can review consent before sending care messages."'}
            rows={5}
            style={{ width: '100%', padding: 12, border: '1px solid #d7dce4', borderRadius: 6, fontFamily: 'inherit', fontSize: 14, resize: 'vertical', boxSizing: 'border-box' }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 }}>
            <button
              type="submit"
              disabled={phase === 'planning' || !intent.trim()}
              style={{ background: phase === 'planning' ? '#5a6573' : '#0b1220', color: '#fff', padding: '10px 24px', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: phase === 'planning' ? 'wait' : 'pointer' }}>
              {phase === 'planning' ? 'Composing plan…' : 'Generate plan →'}
            </button>
            <span style={{ fontSize: 12, color: '#7a8597' }}>
              Powered by Claude · audit logging coming in v2
            </span>
          </div>
        </form>
      )}

      {phase === 'planning' && (
        <div style={{ ...SOFT_CARD, fontSize: 14, color: '#5a6573' }}>
          Scanning the {meta?.catalog_size ?? 88}-SDK catalog and composing your plan. Usually 10–25 seconds.
        </div>
      )}

      {phase === 'done' && plan && (
        <>
          <div style={CARD}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
              <span style={{ ...BADGE, background: PACK_COLORS[plan.vertical_pack]?.bg ?? '#ecf2fc', color: PACK_COLORS[plan.vertical_pack]?.fg ?? '#1a4fc4', border: `1px solid ${PACK_COLORS[plan.vertical_pack]?.border ?? '#b9c3d6'}` }}>
                {plan.vertical_pack}
              </span>
              <span style={{ ...BADGE, background: COMPLEXITY_COLORS[plan.complexity]?.bg ?? '#ecf2fc', color: COMPLEXITY_COLORS[plan.complexity]?.fg ?? '#1a4fc4', border: `1px solid ${COMPLEXITY_COLORS[plan.complexity]?.border ?? '#b9c3d6'}` }}>
                {plan.complexity}
              </span>
              <span style={{ ...BADGE, background: '#f8fafd', color: '#5a6573', border: '1px solid #d7dce4' }}>
                {plan.recommended_sdks.length} SDKs
              </span>
            </div>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.7 }}>{plan.summary}</p>
          </div>

          <h2 style={{ fontSize: 20, marginTop: 28, marginBottom: 12 }}>
            Recommended SDKs <span style={{ color: '#7a8597', fontSize: 14, fontWeight: 400 }}>({plan.recommended_sdks.length})</span>
          </h2>
          <div style={CARD}>
            {plan.recommended_sdks.length === 0 ? (
              <div style={{ color: '#7a8597', fontSize: 14 }}>
                The planner did not recommend any SDKs — your app may be too custom to compose from the existing catalog. See the custom work section below.
              </div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                {plan.recommended_sdks.map((sdk) => (
                  <li key={sdk.name} style={{ padding: '12px 0', borderBottom: '1px solid #eef1f6' }}>
                    <code style={{ fontFamily: 'ui-monospace, monospace', fontSize: 14, fontWeight: 600, color: '#1b2a44' }}>
                      {sdk.name}
                    </code>
                    <div style={{ marginTop: 4, fontSize: 14, color: '#5a6573', lineHeight: 1.55 }}>
                      {sdk.why}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {plan.custom_work.length > 0 && (
            <>
              <h2 style={{ fontSize: 20, marginTop: 28, marginBottom: 12 }}>
                You&apos;ll need to build <span style={{ color: '#7a8597', fontSize: 14, fontWeight: 400 }}>({plan.custom_work.length})</span>
              </h2>
              <div style={CARD}>
                <ul style={{ margin: 0, paddingLeft: 22, lineHeight: 1.8, fontSize: 14, color: '#1b2a44' }}>
                  {plan.custom_work.map((item, i) => <li key={i}>{item}</li>)}
                </ul>
              </div>
            </>
          )}

          {plan.clarifying_questions.length > 0 && (
            <>
              <h2 style={{ fontSize: 20, marginTop: 28, marginBottom: 12 }}>
                Questions to refine the plan
              </h2>
              <div style={CARD}>
                <ul style={{ margin: 0, paddingLeft: 22, lineHeight: 1.8, fontSize: 14, color: '#1b2a44' }}>
                  {plan.clarifying_questions.map((q, i) => <li key={i}>{q}</li>)}
                </ul>
                <p style={{ marginTop: 14, fontSize: 13, color: '#7a8597' }}>
                  Tip: answer these in the prompt and regenerate for a tighter plan.
                </p>
              </div>
            </>
          )}

          <div style={{ display: 'flex', gap: 8, marginTop: 24 }}>
            <button
              onClick={reset}
              style={{ background: '#0b1220', color: '#fff', padding: '10px 22px', border: 'none', borderRadius: 6, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
              Plan another
            </button>
            <button
              onClick={() => {
                setPhase('idle');
                // keep intent so the user can edit it
              }}
              style={{ background: '#f3f5f8', border: '1px solid #d7dce4', padding: '10px 22px', borderRadius: 6, fontSize: 14, cursor: 'pointer', color: '#1b2a44' }}>
              Edit prompt &amp; regenerate
            </button>
            <button
              onClick={() => {
                const payload = JSON.stringify(plan, null, 2);
                navigator.clipboard.writeText(payload).catch(() => undefined);
              }}
              style={{ background: '#f3f5f8', border: '1px solid #d7dce4', padding: '10px 22px', borderRadius: 6, fontSize: 14, cursor: 'pointer', color: '#1b2a44' }}>
              Copy plan as JSON
            </button>
          </div>
        </>
      )}

      {phase === 'error' && error && (
        <div style={{ ...CARD, background: '#fdecea', borderColor: '#f1b9b9' }}>
          <div style={{ fontWeight: 600, marginBottom: 4, color: '#a31818' }}>Plan failed</div>
          <div style={{ fontSize: 14, color: '#5a4a08', wordBreak: 'break-word' }}>{error}</div>
          <p style={{ marginTop: 10, fontSize: 13, color: '#7a8597' }}>
            Common causes: <code>ANTHROPIC_API_KEY</code> not loaded in the dev server&apos;s env,
            request timeout, or rate limit. Try again or check the server logs.
          </p>
        </div>
      )}
    </main>
  );
}
