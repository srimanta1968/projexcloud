import { revalidatePath } from 'next/cache';
import { PageHeader } from '@projexlight/design-system';
import { gateway } from '@/lib/gateway';

/**
 * Attribute-based access policies (TK-4129).
 *
 * WHY THE DRY RUN IS THE FEATURE, NOT A CONVENIENCE
 * A policy engine whose decisions cannot be previewed gets switched off the first time it
 * denies something important — because nobody can tell a CORRECT denial from a misconfigured
 * one, and under pressure the safe-looking move is always to disable the rule. So this screen
 * evaluates against POST /api/policies/evaluate BEFORE anything is saved, and reports which
 * rule matched rather than a bare permit/deny. "Deny, because rule X matched on region" is
 * actionable; "Deny" is an outage waiting to be blamed on the policy engine.
 *
 * policy.decision history is listed for the same reason, after the fact: an admin asked "why
 * was this denied yesterday" needs an answer that is not a reconstruction.
 */

export const dynamic = 'force-dynamic';

interface Policy {
  policy_id: string;
  name: string;
  effect: 'permit' | 'deny';
  target?: Record<string, unknown> | null;
  condition?: Record<string, unknown> | null;
  status?: string;
}

interface Decision {
  decision_id: string;
  policy_id: string | null;
  effect: string;
  subject_ref?: string | null;
  decided_at?: string;
}

async function loadPolicies(): Promise<Policy[]> {
  try {
    // request() already unwraps `data`.
    const res = await gateway.get<{ policies?: Policy[] }>('/api/policies');
    return res?.policies ?? [];
  } catch {
    return [];
  }
}

async function loadDecisions(): Promise<Decision[]> {
  try {
    const res = await gateway.get<{ decisions?: Decision[] }>('/api/policies/decisions?limit=20');
    return res?.decisions ?? [];
  } catch {
    // The history endpoint may not exist in every deployment; an empty list is honest,
    // an error banner would imply the policy screen itself is broken.
    return [];
  }
}

/**
 * Evaluate WITHOUT saving. The result is rendered back onto the page via searchParams so the
 * admin can iterate on the context before committing anything.
 */
async function dryRun(formData: FormData): Promise<void> {
  'use server';
  const raw = String(formData.get('context') ?? '{}');
  let result = '';
  try {
    const res = await gateway.post<Record<string, unknown>>('/api/policies/evaluate', {
      context: JSON.parse(raw || '{}'),
    });
    result = JSON.stringify(res ?? {});
  } catch (err) {
    result = JSON.stringify({ error: (err as Error).message });
  }
  revalidatePath(`/policies?evaluated=${encodeURIComponent(result)}`);
}

/**
 * Point a JSON syntax error at the clause that caused it.
 *
 * JSON.parse reports a character offset, which is useless in a textarea. Converting it to
 * line/column and echoing the offending line is the difference between "invalid rule" — which
 * tells an admin only that they are stuck — and a message they can act on without guessing.
 */
function describeJsonError(raw: string, err: unknown): string {
  const message = (err as Error).message ?? 'invalid JSON';
  const at = /position (\d+)/.exec(message);
  if (!at) return `Condition is not valid JSON: ${message}`;

  const offset = Number(at[1]);
  const before = raw.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - before.lastIndexOf('\n');
  const offending = (raw.split('\n')[line - 1] ?? '').trim();

  return `Condition is not valid JSON at line ${line}, column ${column}`
    + (offending ? ` — the offending clause is: ${offending}` : '')
    + `. Nothing was saved.`;
}

async function createPolicy(formData: FormData): Promise<void> {
  'use server';
  const name = String(formData.get('name') ?? '').trim();
  const effect = String(formData.get('effect') ?? 'deny');
  const condition = String(formData.get('condition') ?? '{}');

  if (!name) {
    revalidatePath(`/policies?saveError=${encodeURIComponent('A rule needs a name before it can be saved.')}`);
    return;
  }

  // PARSE BEFORE SENDING. A malformed condition must be refused here, naming the clause,
  // rather than posted and rejected as an opaque 400 — or, worse, swallowed so the admin
  // believes the rule saved and only discovers otherwise when it fails to deny something.
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(condition || '{}');
  } catch (err) {
    revalidatePath(`/policies?saveError=${encodeURIComponent(describeJsonError(condition, err))}`);
    return;
  }

  try {
    await gateway.post('/api/policies', { name, effect, condition: parsed });
  } catch (err) {
    // Surfaced, not swallowed: a save that silently fails is indistinguishable from one
    // that worked, and the admin walks away believing the rule is live.
    revalidatePath(`/policies?saveError=${encodeURIComponent((err as Error).message)}`);
    return;
  }
  revalidatePath('/policies');
}

export default async function PoliciesPage({
  searchParams,
}: {
  searchParams?: { evaluated?: string; saveError?: string };
}) {
  const [policies, decisions] = await Promise.all([loadPolicies(), loadDecisions()]);
  const evaluated = searchParams?.evaluated;
  const saveError = searchParams?.saveError;

  return (
    <main className="p-8 max-w-5xl mx-auto">
      <PageHeader
        title="Policies"
        description="Attribute-based rules evaluated at request time. Preview a decision before you save it — a rule you cannot preview is one you will end up disabling."
      />

      {/* ── dry run ─────────────────────────────────────────────────────── */}
      <section className="mb-8 border rounded p-4">
        <h2 className="font-medium mb-2">Evaluate a context (nothing is saved)</h2>
        <form action={dryRun} className="space-y-2">
          <textarea
            name="context"
            rows={4}
            className="w-full border rounded p-2 font-mono text-xs"
            defaultValue={'{\n  "region": "us-east-1",\n  "consent": "granted"\n}'}
          />
          <button type="submit" className="text-sm px-3 py-1 border rounded">Evaluate</button>
        </form>
        {evaluated && (
          <pre className="mt-3 bg-gray-50 border rounded p-2 text-xs overflow-x-auto">{evaluated}</pre>
        )}
      </section>

      {/* ── rules ───────────────────────────────────────────────────────── */}
      <section className="mb-8">
        <h2 className="font-medium mb-2">Rules</h2>
        {policies.length === 0 ? (
          <p className="text-sm text-gray-500">No policies yet. Everything is decided by RBAC and ReBAC alone.</p>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left border-b"><th className="py-2">Name</th><th>Effect</th><th>Condition</th></tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.policy_id} className="border-b align-top">
                  <td className="py-2">{p.name}</td>
                  <td className={p.effect === 'deny' ? 'text-red-700' : 'text-emerald-700'}>{p.effect}</td>
                  <td><code className="text-xs">{JSON.stringify(p.condition ?? {})}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="mb-8 border rounded p-4">
        <h2 className="font-medium mb-2">Add a rule</h2>
        {saveError && (
          <p role="alert" className="text-sm text-red-700 border border-red-300 rounded p-2 mb-2">
            {saveError}
          </p>
        )}
        <form action={createPolicy} className="space-y-2">
          <input name="name" placeholder="Rule name" className="border rounded px-2 py-1 text-sm w-full" />
          <select name="effect" className="border rounded px-2 py-1 text-sm">
            <option value="deny">deny</option>
            <option value="permit">permit</option>
          </select>
          <textarea
            name="condition"
            rows={3}
            className="w-full border rounded p-2 font-mono text-xs"
            defaultValue={'{ "region": "us-east-1" }'}
          />
          <button type="submit" className="text-sm px-3 py-1 border rounded">Save rule</button>
        </form>
      </section>

      {/* ── history ─────────────────────────────────────────────────────── */}
      <section>
        <h2 className="font-medium mb-2">Recent decisions</h2>
        {decisions.length === 0 ? (
          <p className="text-sm text-gray-500">No decisions recorded yet.</p>
        ) : (
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr className="text-left border-b"><th className="py-2">When</th><th>Effect</th><th>Rule</th><th>Subject</th></tr>
            </thead>
            <tbody>
              {decisions.map((d) => (
                <tr key={d.decision_id} className="border-b">
                  <td className="py-2">{d.decided_at ?? '—'}</td>
                  <td>{d.effect}</td>
                  <td className="text-gray-500">{d.policy_id?.slice(0, 8) ?? '—'}</td>
                  <td className="text-gray-500">{d.subject_ref ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
