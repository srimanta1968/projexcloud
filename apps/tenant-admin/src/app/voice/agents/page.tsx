import Link from 'next/link';
import { Alert, Badge, Button, Card, Field, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@projexlight/design-system';
import { gateway, GatewayError } from '../../../lib/gateway';
import { createAgentAction } from './actions';

/** Voice agents (VA·E9 · TK-4513): the tenant's agents, and a form to start a new one. */

interface AgentRow {
  agent_id: string;
  name: string;
  direction: string;
  status: string;
  published_version_id: string | null;
}

export default async function VoiceAgentsPage({ searchParams }: { searchParams: { error?: string } }) {
  let agents: AgentRow[] = [];
  let error = searchParams.error;
  try {
    agents = (await gateway.get<{ agents: AgentRow[] }>('/api/voice-agent/agents?limit=200')).agents;
  } catch (err) {
    error = err instanceof GatewayError ? err.message : 'Could not load agents';
  }

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Voice agents</h1>
        <p className="text-muted-foreground">Build an agent from a preset stack, preview its voice, test it, then publish it.</p>
      </div>
      {error ? <Alert variant="destructive" data-testid="voice-agents-error">{error}</Alert> : null}

      <Card className="grid gap-3 p-4">
        <h2 className="text-lg font-semibold">New agent</h2>
        <form action={createAgentAction} className="flex flex-wrap items-end gap-3">
          <Field label="Name" htmlFor="name">
            <Input id="name" name="name" required maxLength={120} placeholder="Agent name" />
          </Field>
          <Field label="Direction" htmlFor="direction">
            <Select id="direction" name="direction" defaultValue="inbound">
              <option value="inbound">inbound</option>
              <option value="outbound">outbound</option>
              <option value="both">both</option>
            </Select>
          </Field>
          <Button type="submit" data-testid="voice-agents-create">Create agent</Button>
        </form>
      </Card>

      <Card className="p-4">
        {agents.length === 0 ? (
          <p className="text-muted-foreground" data-testid="voice-agents-empty">No agents yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {agents.map((a) => (
                <TableRow key={a.agent_id}>
                  <TableCell><Link href={`/voice/agents/${a.agent_id}`} className="underline">{a.name}</Link></TableCell>
                  <TableCell>{a.direction}</TableCell>
                  <TableCell>
                    <Badge variant={a.published_version_id ? 'success' : 'secondary'}>{a.published_version_id ? 'live' : 'draft'}</Badge>
                    {a.status !== 'draft' && a.status !== 'published' ? <span className="ml-2 text-xs text-muted-foreground">{a.status}</span> : null}
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
