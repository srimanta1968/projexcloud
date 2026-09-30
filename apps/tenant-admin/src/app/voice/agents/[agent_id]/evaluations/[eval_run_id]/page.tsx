import Link from 'next/link';
import { Alert, Badge, Card, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@projexlight/design-system';
import { gateway, GatewayError } from '../../../../../../lib/gateway';
import { AutoRefresh, EvalStatus } from '../../../EvalBits';

/**
 * One evaluation run (VA·E10 · TK-4518): verdict, metrics against thresholds, and per scenario
 * the checks, the tool calls and the transcript the simulated caller produced. Refreshes itself
 * while the run is queued or running.
 */

interface Check { name: string; passed: boolean; detail?: string }
interface ScenarioResult {
  name: string; call_id: string; passed: boolean; checks: Check[]; error: string | null;
  tools: { name: string; ok: boolean; error: string | null; ms: number }[];
  transfer_requested: boolean; ttft_ms: number[]; barge_in_stop_ms: number[];
  transcript: { speaker: string; text: string; interrupted: boolean }[]; duration_ms: number;
}
interface EvalRun {
  eval_run_id: string; agent_id: string; version_id: string; suite: string;
  mode: 'reported' | 'sandbox' | 'evaluation'; status: 'queued' | 'running' | 'completed' | 'error';
  passed: boolean | null; score: number | null; results: ScenarioResult[]; metrics: Record<string, unknown>;
  error: string | null; started_at: string | null; finished_at: string | null; created_at: string;
}

const CHECK_LABELS: Record<string, string> = {
  answered: 'Every caller line got a real answer',
  tools_ok: 'Every tool call succeeded',
  transfer: 'Transfer to a human as expected',
  says_any: 'Said one of the expected phrases',
  barge_in: 'Stopped talking when interrupted',
  ttft_p95: 'Response latency (p95 time to first token)',
};
const label = (name: string): string => {
  if (CHECK_LABELS[name]) return CHECK_LABELS[name];
  const [kind, arg] = name.split(':');
  if (kind === 'tool_called') return `Called the ${arg} tool`;
  if (kind === 'tool_not_called') return `Did not call the ${arg} tool`;
  if (kind === 'says_none') return `Never said "${arg}"`;
  return name;
};
const ms = (v: unknown): string => (typeof v === 'number' ? `${v} ms` : '—');

function CheckList({ checks, testId }: { checks: Check[]; testId: string }): React.JSX.Element {
  return (
    <ul className="grid gap-1 text-sm" data-testid={testId}>
      {checks.map((c) => (
        <li key={c.name} className="flex items-start gap-2">
          <Badge variant={c.passed ? 'success' : 'destructive'}>{c.passed ? 'pass' : 'fail'}</Badge>
          <span>{label(c.name)}{c.detail ? <span className="text-muted-foreground"> — {c.detail}</span> : null}</span>
        </li>
      ))}
    </ul>
  );
}

export default async function EvalRunPage({ params }: { params: { agent_id: string; eval_run_id: string } }) {
  let run: EvalRun;
  try {
    run = (await gateway.get<{ eval_run: EvalRun }>(`/api/voice-agent/eval-runs/${encodeURIComponent(params.eval_run_id)}`)).eval_run;
  } catch (err) {
    return <Alert variant="destructive" data-testid="eval-error">{err instanceof GatewayError ? err.message : 'Could not load the evaluation run'}</Alert>;
  }
  const active = run.status === 'queued' || run.status === 'running';
  const m = run.metrics ?? {};
  const runChecks = (m.run_checks as Check[] | undefined) ?? [];

  return (
    <div className="grid gap-6">
      <AutoRefresh active={active} />
      <div>
        <Link href={`/voice/agents/${params.agent_id}`} className="text-sm text-muted-foreground">← Agent</Link>
        <h1 className="text-2xl font-semibold">
          {run.mode === 'sandbox' ? 'Sandbox check' : run.mode === 'evaluation' ? 'Evaluation run' : 'Recorded result'}
        </h1>
        <p className="flex items-center gap-2 text-muted-foreground">
          <EvalStatus run={run} testId="eval-run-status" /> suite {run.suite} · started {new Date(run.created_at).toLocaleString()}
        </p>
      </div>

      {run.mode === 'sandbox' ? (
        <Alert data-testid="eval-sandbox-note">
          Sandbox checks run on fake speech providers with a scripted agent. They prove your tools and the call flow work,
          and never count toward publishing — run an evaluation for that.
        </Alert>
      ) : null}
      {active ? <Alert data-testid="eval-running">Simulated callers are talking to the agent. This page updates by itself.</Alert> : null}
      {run.status === 'error' ? <Alert variant="destructive" data-testid="eval-run-error">The run could not complete: {run.error}</Alert> : null}

      {run.status === 'completed' ? (
        <Card className="grid gap-3 p-4" data-testid="eval-metrics">
          <h2 className="text-lg font-semibold">Summary</h2>
          <div className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4">
            <div><div className="text-muted-foreground">Scenarios passed</div>{String(m.scenarios_passed ?? 0)} / {String(m.scenarios ?? run.results.length)}</div>
            <div><div className="text-muted-foreground">Time to first token p50 / p95</div>{run.mode === 'sandbox' ? 'n/a (scripted agent)' : `${ms(m.ttft_p50_ms)} / ${ms(m.ttft_p95_ms)}`}</div>
            <div><div className="text-muted-foreground">Slowest stop when interrupted</div>{ms(m.barge_in_max_stop_ms)}</div>
            <div><div className="text-muted-foreground">Tool calls (errors)</div>{String(m.tool_calls ?? 0)} ({String(m.tool_errors ?? 0)})</div>
          </div>
          {runChecks.length ? <CheckList checks={runChecks} testId="eval-run-checks" /> : null}
        </Card>
      ) : null}

      {run.results.map((r, i) => (
        <Card key={r.name} className="grid gap-3 p-4" data-testid={`eval-scenario-${i}`}>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            {r.name} <Badge variant={r.passed ? 'success' : 'destructive'}>{r.passed ? 'passed' : 'failed'}</Badge>
          </h2>
          {r.error ? <Alert variant="destructive">{r.error}</Alert> : null}
          {r.checks.length ? <CheckList checks={r.checks} testId={`eval-checks-${i}`} /> : null}
          {r.tools.length ? (
            <p className="text-sm">
              Tools: {r.tools.map((t, j) => <span key={j} className="mr-2"><Badge variant={t.ok ? 'outline' : 'destructive'}>{t.name} {t.ok ? `${t.ms} ms` : t.error}</Badge></span>)}
            </p>
          ) : null}
          {r.transcript.length ? (
            <Table>
              <TableHeader><TableRow><TableHead>Speaker</TableHead><TableHead>Said</TableHead></TableRow></TableHeader>
              <TableBody>
                {r.transcript.map((t, j) => (
                  <TableRow key={j}>
                    <TableCell>{t.speaker === 'caller' ? 'Simulated caller' : 'Agent'}</TableCell>
                    <TableCell>{t.text || <span className="text-muted-foreground">(nothing heard)</span>}{t.interrupted ? <Badge variant="outline" className="ml-2">interrupted</Badge> : null}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
        </Card>
      ))}
    </div>
  );
}
