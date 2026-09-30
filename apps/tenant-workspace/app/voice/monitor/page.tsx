'use client';

import Link from 'next/link';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Alert, Badge, Button, Card } from '@projexlight/design-system';
import { apiGet, apiPost, gatewayWsBase, type ApiError } from '../../../lib/apiClient';
import { emptyLive, liveReducer, type LiveMessage, type Turn } from './transcript';

/**
 * Live calls (VA·E9 · TK-4515): a supervisor sees the tenant's active AI calls, opens one to
 * follow its transcript live, and opens completed calls to read their transcript, summary
 * and outcome.
 *
 * Live view: a single-use ticket is minted with the supervisor's token (POST live-ticket —
 * the viewer's access to the call is checked there), then the browser opens the call's
 * WebSocket with ?ticket= (browsers cannot put a bearer header on a WebSocket, and a JWT in
 * the URL would land in proxy logs). The socket sends a snapshot, then every new turn,
 * status change and the end of the call.
 */

interface CallRow {
  call_id: string;
  agent_id: string;
  direction: string;
  status: string;
  to_number: string | null;
  from_number: string | null;
  subject_ref: string | null;
  disposition: string | null;
  summary: string | null;
  duration_s: number | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}
interface CallDetail extends CallRow { transcript: Turn[] }

const ACTIVE = ['dialing', 'ringing', 'in_progress', 'transferred'];
const POLL_MS = 5000;

function counterpart(c: CallRow): string {
  return (c.direction === 'outbound' ? c.to_number : c.from_number) ?? c.subject_ref ?? '—';
}

function TranscriptView({ turns }: { turns: Turn[] }) {
  if (turns.length === 0) return <p className="text-muted-foreground" data-testid="transcript-empty">No turns yet.</p>;
  return (
    <ol className="grid gap-2" data-testid="transcript">
      {turns.map((t) => (
        <li key={t.turn_index} className={t.speaker === 'agent' ? 'text-left' : t.speaker === 'caller' ? 'text-right' : 'text-center text-xs text-muted-foreground'}>
          <span className="mr-2 text-xs uppercase text-muted-foreground">{t.speaker}</span>
          <span data-testid={`turn-${t.turn_index}`}>{t.text}</span>
          {t.interrupted ? <span className="ml-1 text-xs text-muted-foreground">(interrupted)</span> : null}
        </li>
      ))}
    </ol>
  );
}

function LiveCall({ call, onClose }: { call: CallRow; onClose: () => void }) {
  const [state, dispatch] = useReducer(liveReducer, emptyLive);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let cancelled = false;
    (async () => {
      try {
        const t = await apiPost<{ ticket: { ws_path: string } }>(`/api/voice-agent/calls/${encodeURIComponent(call.call_id)}/live-ticket`, {});
        if (cancelled) return;
        socket = new WebSocket(`${gatewayWsBase()}${t.ticket.ws_path}`);
        socket.onopen = () => setConnected(true);
        socket.onmessage = (ev) => {
          try { dispatch(JSON.parse(String(ev.data)) as LiveMessage); } catch { /* ignore a malformed frame */ }
        };
        socket.onclose = () => setConnected(false);
        socket.onerror = () => setError('The live connection failed.');
      } catch (err) {
        setError((err as ApiError).details?.join('; ') || (err as ApiError).error || 'Could not open the live view');
      }
    })();
    return () => { cancelled = true; socket?.close(); };
  }, [call.call_id]);

  return (
    <Card className="grid gap-3 p-4" data-testid="live-call">
      <div className="flex items-center justify-between">
        <div>
          <strong>{counterpart(call)}</strong>{' '}
          <Badge variant={state.ended ? 'secondary' : 'success'} data-testid="live-status">{state.ended ? `ended (${state.status ?? 'completed'})` : state.status ?? call.status}</Badge>{' '}
          <span className="text-xs text-muted-foreground" data-testid="live-connection">{connected ? 'live' : state.ended ? 'closed' : 'connecting…'}</span>
        </div>
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
      </div>
      {error ? <Alert variant="destructive" data-testid="live-error">{error}</Alert> : null}
      <TranscriptView turns={state.turns} />
      {state.ended && state.disposition ? <div className="text-sm">Outcome: {state.disposition}</div> : null}
    </Card>
  );
}

function CompletedCall({ callId, onClose }: { callId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    apiGet<{ call: CallDetail }>(`/api/voice-agent/calls/${encodeURIComponent(callId)}`)
      .then((r) => setDetail(r.call))
      .catch((err: ApiError) => setError(err.details?.join('; ') || err.error || 'Could not load the call'));
  }, [callId]);
  return (
    <Card className="grid gap-3 p-4" data-testid="completed-call">
      <div className="flex items-center justify-between">
        <strong>Transcript</strong>
        <Button variant="secondary" size="sm" onClick={onClose}>Close</Button>
      </div>
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {detail ? (
        <>
          <div className="text-sm text-muted-foreground">
            {counterpart(detail)} · {detail.status}{detail.disposition ? ` · ${detail.disposition}` : ''}{detail.duration_s !== null ? ` · ${detail.duration_s}s` : ''}
          </div>
          {detail.summary ? <p data-testid="call-summary">{detail.summary}</p> : null}
          <TranscriptView turns={detail.transcript} />
        </>
      ) : null}
    </Card>
  );
}

export default function VoiceMonitorPage() {
  const [active, setActive] = useState<CallRow[]>([]);
  const [completed, setCompleted] = useState<CallRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState<CallRow | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const pages = await Promise.all(ACTIVE.map((s) => apiGet<{ calls: CallRow[] }>(`/api/voice-agent/calls?status=${s}&is_test=false&limit=100`)));
      setActive(pages.flatMap((p) => p.calls));
      setCompleted((await apiGet<{ calls: CallRow[] }>('/api/voice-agent/calls?status=completed&limit=50')).calls);
      setError(null);
    } catch (err) {
      setError((err as ApiError).details?.join('; ') || (err as ApiError).error || 'Could not load calls');
    }
  }, []);

  useEffect(() => {
    void load();
    timer.current = setInterval(() => void load(), POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [load]);

  return (
    <main className="mx-auto grid max-w-5xl gap-6 p-6">
      <div>
        <Link href="/dashboard" className="text-sm text-muted-foreground">← Dashboard</Link>
        <h1 className="text-2xl font-semibold">Live calls</h1>
        <p className="text-muted-foreground">Active AI calls update every {POLL_MS / 1000}s. Open one to follow its transcript live.</p>
      </div>
      {error ? <Alert variant="destructive" data-testid="monitor-error">{error}</Alert> : null}

      <section className="grid gap-3" data-testid="active-calls">
        <h2 className="text-lg font-semibold">Active calls ({active.length})</h2>
        {active.length === 0 ? <p className="text-muted-foreground" data-testid="active-empty">No calls in progress.</p> : (
          <ul className="grid gap-2">
            {active.map((c) => (
              <li key={c.call_id} className="flex items-center justify-between rounded-md border p-3">
                <span>
                  <strong>{counterpart(c)}</strong> <span className="text-sm text-muted-foreground">{c.direction} · {c.status}</span>
                </span>
                <Button size="sm" onClick={() => { setOpened(null); setLive(c); }} data-testid={`watch-${c.call_id}`}>Watch live</Button>
              </li>
            ))}
          </ul>
        )}
        {live ? <LiveCall key={live.call_id} call={live} onClose={() => setLive(null)} /> : null}
      </section>

      <section className="grid gap-3" data-testid="completed-calls">
        <h2 className="text-lg font-semibold">Completed calls</h2>
        {completed.length === 0 ? <p className="text-muted-foreground">No completed calls yet.</p> : (
          <ul className="grid gap-2">
            {completed.map((c) => (
              <li key={c.call_id} className="flex items-center justify-between rounded-md border p-3">
                <span>
                  <strong>{counterpart(c)}</strong>{' '}
                  <span className="text-sm text-muted-foreground">{c.disposition ?? c.status}{c.ended_at ? ` · ${new Date(c.ended_at).toLocaleString()}` : ''}</span>
                </span>
                <Button size="sm" variant="secondary" onClick={() => { setLive(null); setOpened(c.call_id); }} data-testid={`open-${c.call_id}`}>Open transcript</Button>
              </li>
            ))}
          </ul>
        )}
        {opened ? <CompletedCall key={opened} callId={opened} onClose={() => setOpened(null)} /> : null}
      </section>
    </main>
  );
}
