import Link from 'next/link';
import { Alert, Badge, Button, Card, Field, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from '@projexlight/design-system';
import { gateway, GatewayError } from '../../../../lib/gateway';
import { TalkPanel } from '../../test/TalkPanel';
import { VoicePreview } from './VoicePreview';
import {
  createStackProfileAction,
  createVersionAction,
  publishAction,
  recordTestResultAction,
  requestApprovalAction,
  rollbackAction,
} from '../actions';

/**
 * Agent builder (VA·E9 · TK-4513): build an agent from a preset stack, preview its voice,
 * test it in the browser, then publish it.
 *
 *   1. Stack   — clone a preset into a stack profile, choosing a validated key per slot.
 *   2. Version — prompt, greeting, language and stack; versions are immutable.
 *   3. Preview — hear a voice with one of the tenant's TTS keys.
 *   4. Test    — talk to the latest version (a draft) with the TalkToAgent widget.
 *   5. Publish — two gates, enforced by the gateway: a recorded passing test AND an approval
 *                on one of the tenant's approval routes (decided by an approver, not here).
 *                A previously published version can be rolled back to.
 */

interface Agent { agent_id: string; name: string; direction: string; status: string; published_version_id: string | null }
interface Version {
  version_id: string; version_no: number; system_prompt: string; greeting: string | null; language: string;
  stack_profile_id: string; eval_run_id: string | null; approval_id: string | null; published_at: string | null; is_live: boolean; created_at: string;
}
interface StackProfile { profile_id: string; name: string; preset_key: string | null; status?: string }
interface Preset { key: string; name: string; estimated_cost_per_min: { low: number; high: number }; available: boolean }
interface Binding { binding_id: string; provider_id: string; layer: string; priority: string; status: string; validation_status: string; last_4: string }
interface Route { route_id: string; name: string; status: string }

const SLOTS: { slot: string; layer: string; label: string }[] = [
  { slot: 'telephony', layer: 'telephony', label: 'Telephony' },
  { slot: 'stt', layer: 'stt', label: 'Speech-to-text' },
  { slot: 'llm_fast', layer: 'llm', label: 'LLM (fast)' },
  { slot: 'llm_complex', layer: 'llm', label: 'LLM (complex)' },
  { slot: 'tts', layer: 'tts', label: 'Text-to-speech' },
];

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

async function load(agentId: string) {
  const id = encodeURIComponent(agentId);
  const [agentRes, versions, profiles, presets, creds, routes] = await Promise.all([
    gateway.get<{ agent: Agent }>(`/api/voice-agent/agents/${id}`),
    safe(gateway.get<{ versions: Version[] }>(`/api/voice-agent/agents/${id}/versions?limit=50`), { versions: [] }),
    safe(gateway.get<{ stack_profiles: StackProfile[] }>('/api/voice-agent/stack-profiles?limit=100'), { stack_profiles: [] }),
    safe(gateway.get<{ presets: Preset[] }>('/api/voice-agent/presets'), { presets: [] }),
    safe(gateway.get<{ bindings: Binding[] }>('/api/ai-gateway/tenant-credentials'), { bindings: [] }),
    safe(gateway.get<Route[]>('/api/approvals/routes'), [] as Route[]),
  ]);
  const approvals = new Map<string, string>();
  await Promise.all(versions.versions.filter((v) => v.approval_id).map(async (v) => {
    const r = await safe(gateway.get<{ request?: { status: string }; status?: string }>(`/api/approvals/requests/${encodeURIComponent(v.approval_id as string)}`), {});
    approvals.set(v.version_id, r.request?.status ?? r.status ?? 'unknown');
  }));
  return {
    agent: agentRes.agent,
    versions: [...versions.versions].sort((a, b) => b.version_no - a.version_no),
    profiles: profiles.stack_profiles.filter((p) => !p.status || p.status === 'active'),
    presets: presets.presets,
    keys: creds.bindings.filter((b) => b.status === 'active' && b.validation_status === 'ok'),
    routes: (Array.isArray(routes) ? routes : []).filter((r) => r.status === 'active'),
    approvals,
  };
}

const NOTICES: Record<string, string> = {
  created: 'Agent created. Start with a stack, then a first version.',
  profile: 'Stack profile created.',
  version: 'Version saved.',
  tested: 'Test result recorded.',
  requested: 'Approval requested. An approver decides it under Approvals.',
  published: 'Version published — it is now live.',
  rolled_back: 'Rolled back — the selected version is live again.',
};

export default async function AgentBuilderPage({ params, searchParams }: { params: { agent_id: string }; searchParams: Record<string, string | undefined> }) {
  let data: Awaited<ReturnType<typeof load>>;
  try {
    data = await load(params.agent_id);
  } catch (err) {
    return <Alert variant="destructive" data-testid="agent-error">{err instanceof GatewayError ? err.message : 'Could not load the agent'}</Alert>;
  }
  const { agent, versions, profiles, presets, keys, routes, approvals } = data;
  const latest = versions[0];
  const notice = Object.keys(NOTICES).find((k) => searchParams[k]);
  const keyOptions = (layer: string) => keys.filter((k) => k.layer === layer);

  return (
    <div className="grid gap-6">
      <div>
        <Link href="/voice/agents" className="text-sm text-muted-foreground">← Voice agents</Link>
        <h1 className="text-2xl font-semibold" data-testid="agent-name">{agent.name}</h1>
        <p className="text-muted-foreground">
          {agent.direction} · <Badge variant={agent.published_version_id ? 'success' : 'secondary'}>{agent.published_version_id ? 'live' : 'draft'}</Badge>
        </p>
      </div>
      {searchParams.error ? <Alert variant="destructive" data-testid="agent-action-error">{searchParams.error}</Alert> : null}
      {notice ? <Alert variant="success" data-testid="agent-notice">{searchParams.tested === 'failed' ? 'Test recorded as failed — this version cannot be published.' : NOTICES[notice]}</Alert> : null}

      {/* 1. Stack */}
      <Card className="grid gap-3 p-4" data-testid="agent-stack">
        <h2 className="text-lg font-semibold">1. Stack from a preset</h2>
        <form action={createStackProfileAction} className="grid gap-3">
          <input type="hidden" name="agent_id" value={agent.agent_id} />
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Stack name" htmlFor="stack_name">
              <Input id="stack_name" name="name" required placeholder="Stack name" defaultValue={`${agent.name} stack`} />
            </Field>
            <Field label="Preset" htmlFor="preset_key">
              <Select id="preset_key" name="preset_key" required>
                {presets.map((p) => (
                  <option key={p.key} value={p.key} disabled={!p.available}>
                    {p.name} (${p.estimated_cost_per_min.low.toFixed(3)}–${p.estimated_cost_per_min.high.toFixed(3)}/min){p.available ? '' : ' — unavailable'}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid gap-3 md:grid-cols-5">
            {SLOTS.map((s) => (
              <Field key={s.slot} label={s.label} htmlFor={`cred_${s.slot}`}>
                <Select id={`cred_${s.slot}`} name={`cred_${s.slot}`} defaultValue={keyOptions(s.layer)[0]?.binding_id ?? ''}>
                  <option value="">— none —</option>
                  {keyOptions(s.layer).map((k) => <option key={k.binding_id} value={k.binding_id}>{k.provider_id} ••••{k.last_4} ({k.priority})</option>)}
                </Select>
              </Field>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Only validated keys are offered. Add keys under <Link href="/voice/keys" className="underline">Voice keys</Link>.</p>
          <div><Button type="submit" variant="secondary" data-testid="agent-create-stack">Create stack</Button></div>
        </form>
      </Card>

      {/* 2. Version */}
      <Card className="grid gap-3 p-4" data-testid="agent-version-form">
        <h2 className="text-lg font-semibold">2. New version</h2>
        {profiles.length === 0 ? <p className="text-muted-foreground">Create a stack first.</p> : (
          <form action={createVersionAction} className="grid gap-3">
            <input type="hidden" name="agent_id" value={agent.agent_id} />
            <Field label="System prompt" htmlFor="system_prompt">
              <Textarea id="system_prompt" name="system_prompt" required rows={5} defaultValue={latest?.system_prompt ?? ''} placeholder="What the agent does and how it should speak" />
            </Field>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Greeting" htmlFor="greeting">
                <Input id="greeting" name="greeting" defaultValue={latest?.greeting ?? ''} placeholder="First thing the agent says" />
              </Field>
              <Field label="Language" htmlFor="language">
                <Input id="language" name="language" defaultValue={latest?.language ?? 'en-US'} />
              </Field>
              <Field label="Stack" htmlFor="stack_profile_id">
                <Select id="stack_profile_id" name="stack_profile_id" defaultValue={latest?.stack_profile_id ?? profiles[0]?.profile_id}>
                  {profiles.map((p) => <option key={p.profile_id} value={p.profile_id}>{p.name}{p.preset_key ? ` (${p.preset_key})` : ''}</option>)}
                </Select>
              </Field>
              <Button type="submit" data-testid="agent-save-version">Save version</Button>
            </div>
          </form>
        )}
      </Card>

      {/* 3. Preview */}
      <Card className="grid gap-3 p-4">
        <h2 className="text-lg font-semibold">3. Preview a voice</h2>
        <VoicePreview ttsKeys={keyOptions('tts').map((k) => ({ binding_id: k.binding_id, label: `${k.provider_id} ••••${k.last_4}` }))} />
      </Card>

      {/* 4. Test */}
      <Card className="grid gap-3 p-4" data-testid="agent-test">
        <h2 className="text-lg font-semibold">4. Test the latest version</h2>
        {latest ? <TalkPanel agentId={agent.agent_id} agentName={`${agent.name} v${latest.version_no}`} /> : <p className="text-muted-foreground">Save a version to test it.</p>}
      </Card>

      {/* 5. Versions & publish */}
      <Card className="grid gap-3 p-4" data-testid="agent-versions">
        <h2 className="text-lg font-semibold">5. Versions &amp; publish</h2>
        {versions.length === 0 ? <p className="text-muted-foreground">No versions yet.</p> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Version</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Test</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {versions.map((v) => (
                <TableRow key={v.version_id} data-testid={`version-${v.version_no}`}>
                  <TableCell>v{v.version_no}</TableCell>
                  <TableCell>
                    {v.is_live ? <Badge variant="success">live</Badge> : v.published_at ? <Badge variant="outline">previously published</Badge> : <Badge variant="secondary">draft</Badge>}
                  </TableCell>
                  <TableCell>
                    {v.eval_run_id ? 'recorded' : 'not tested'}
                    {!v.published_at ? (
                      <div className="mt-1 flex gap-1">
                        <form action={recordTestResultAction}>
                          <input type="hidden" name="agent_id" value={agent.agent_id} />
                          <input type="hidden" name="version_id" value={v.version_id} />
                          <input type="hidden" name="passed" value="true" />
                          <Button type="submit" size="sm" variant="secondary">Test passed</Button>
                        </form>
                        <form action={recordTestResultAction}>
                          <input type="hidden" name="agent_id" value={agent.agent_id} />
                          <input type="hidden" name="version_id" value={v.version_id} />
                          <input type="hidden" name="passed" value="false" />
                          <Button type="submit" size="sm" variant="ghost">Test failed</Button>
                        </form>
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {v.approval_id ? <span data-testid={`approval-${v.version_no}`}>{approvals.get(v.version_id) ?? 'requested'}</span> : 'none'}
                    {!v.published_at && !v.approval_id ? (
                      routes.length === 0 ? <div className="text-xs text-muted-foreground">No approval route — create one under Approvals.</div> : (
                        <form action={requestApprovalAction} className="mt-1 flex gap-1">
                          <input type="hidden" name="agent_id" value={agent.agent_id} />
                          <input type="hidden" name="version_id" value={v.version_id} />
                          <Select name="route_id" aria-label="Approval route">
                            {routes.map((r) => <option key={r.route_id} value={r.route_id}>{r.name}</option>)}
                          </Select>
                          <Button type="submit" size="sm" variant="secondary">Request approval</Button>
                        </form>
                      )
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {!v.is_live && !v.published_at ? (
                      <form action={publishAction}>
                        <input type="hidden" name="agent_id" value={agent.agent_id} />
                        <input type="hidden" name="version_id" value={v.version_id} />
                        <Button type="submit" size="sm" data-testid={`publish-${v.version_no}`}>Publish</Button>
                      </form>
                    ) : null}
                    {!v.is_live && v.published_at ? (
                      <form action={rollbackAction}>
                        <input type="hidden" name="agent_id" value={agent.agent_id} />
                        <input type="hidden" name="version_id" value={v.version_id} />
                        <Button type="submit" size="sm" variant="secondary">Roll back to this</Button>
                      </form>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
