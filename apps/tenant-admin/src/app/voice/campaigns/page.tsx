import Link from 'next/link';
import { Alert, Badge, Button, Card, Field, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@projexlight/design-system';
import { gateway, GatewayError } from '../../../lib/gateway';
import { createCampaignAction } from './actions';

/** Outbound campaigns (VA·E9 · TK-4514): list with status, and a form to create one. */

interface Agent { agent_id: string; name: string; direction: string; published_version_id: string | null }
interface Campaign { campaign_id: string; agent_id: string; name: string; status: string; window_start: string; window_end: string; default_timezone: string }

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'secondary' | 'outline'> = {
  running: 'success', paused: 'warning', draft: 'secondary', completed: 'outline', cancelled: 'outline',
};

export default async function VoiceCampaignsPage({ searchParams }: { searchParams: { error?: string } }) {
  let agents: Agent[] = [];
  let campaigns: Campaign[] = [];
  let error = searchParams.error;
  try {
    [agents, campaigns] = await Promise.all([
      gateway.get<{ agents: Agent[] }>('/api/voice-agent/agents?limit=200').then((r) => r.agents),
      gateway.get<{ campaigns: Campaign[] }>('/api/dialer/campaigns?limit=200').then((r) => r.campaigns),
    ]);
  } catch (err) {
    error = err instanceof GatewayError ? err.message : 'Could not load campaigns';
  }
  const agentName = (id: string) => agents.find((a) => a.agent_id === id)?.name ?? id;
  // A campaign dials out, so only agents that may place outbound calls are offered.
  const dialers = agents.filter((a) => a.direction !== 'inbound');

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Campaigns</h1>
        <p className="text-muted-foreground">Outbound calling runs: an agent, a contact list, and the recipient-local hours it may call in.</p>
      </div>
      {error ? <Alert variant="destructive" data-testid="voice-campaigns-error">{error}</Alert> : null}

      <Card className="grid gap-3 p-4">
        <h2 className="text-lg font-semibold">New campaign</h2>
        {dialers.length === 0 ? <p className="text-muted-foreground">Create an outbound (or both-way) agent first.</p> : (
          <form action={createCampaignAction} className="grid gap-3 md:grid-cols-4 md:items-end">
            <Field label="Name" htmlFor="name"><Input id="name" name="name" required placeholder="Campaign name" /></Field>
            <Field label="Agent" htmlFor="agent_id">
              <Select id="agent_id" name="agent_id" required>
                {dialers.map((a) => <option key={a.agent_id} value={a.agent_id}>{a.name}{a.published_version_id ? '' : ' (draft — publish before starting)'}</option>)}
              </Select>
            </Field>
            <Field label="Default time zone" htmlFor="default_timezone" hint="For contacts without their own">
              <Input id="default_timezone" name="default_timezone" required defaultValue="America/New_York" />
            </Field>
            <Field label="Voicemail" htmlFor="voicemail_policy">
              <Select id="voicemail_policy" name="voicemail_policy" defaultValue="hang_up">
                <option value="hang_up">hang up</option>
                <option value="drop_tts">leave a spoken message</option>
                <option value="drop_recording">leave a recording</option>
              </Select>
            </Field>
            <Field label="Call from" htmlFor="window_start"><Input id="window_start" name="window_start" type="time" defaultValue="09:00" required /></Field>
            <Field label="Call until" htmlFor="window_end"><Input id="window_end" name="window_end" type="time" defaultValue="20:00" required /></Field>
            <Field label="Max concurrent calls" htmlFor="max_concurrency"><Input id="max_concurrency" name="max_concurrency" type="number" min={1} max={1000} defaultValue={5} /></Field>
            <Field label="Max attempts per contact" htmlFor="max_attempts"><Input id="max_attempts" name="max_attempts" type="number" min={1} max={10} defaultValue={3} /></Field>
            <Button type="submit" data-testid="voice-campaigns-create">Create campaign</Button>
          </form>
        )}
      </Card>

      <Card className="p-4">
        {campaigns.length === 0 ? <p className="text-muted-foreground" data-testid="voice-campaigns-empty">No campaigns yet.</p> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Hours (recipient-local)</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {campaigns.map((c) => (
                <TableRow key={c.campaign_id}>
                  <TableCell><Link href={`/voice/campaigns/${c.campaign_id}`} className="underline">{c.name}</Link></TableCell>
                  <TableCell>{agentName(c.agent_id)}</TableCell>
                  <TableCell>{c.window_start}–{c.window_end}</TableCell>
                  <TableCell><Badge variant={STATUS_VARIANT[c.status] ?? 'secondary'}>{c.status}</Badge></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
