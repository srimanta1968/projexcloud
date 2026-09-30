import { Alert, Button, Card, Field, Select } from '@projexlight/design-system';
import { gateway, GatewayError } from '../../../lib/gateway';
import { TalkPanel } from './TalkPanel';

/**
 * Talk to an agent (VA·E9 · TK-4511) — the embeddable TalkToAgent widget, hosted in the
 * tenant portal so an admin can hold a voice conversation with an agent (drafts included)
 * before publishing it. The widget asks for the microphone first and says so when it is
 * blocked; the session itself is started server-side by startTestSessionAction.
 */

interface AgentRow {
  agent_id: string;
  name: string;
  status: string;
  published_version_id: string | null;
}

async function loadAgents(): Promise<{ agents: AgentRow[]; error?: string }> {
  try {
    const page = await gateway.get<{ agents: AgentRow[] }>('/api/voice-agent/agents?limit=100');
    return { agents: page.agents };
  } catch (err) {
    return { agents: [], error: err instanceof GatewayError ? err.message : 'Could not load agents' };
  }
}

export default async function VoiceTestPage({ searchParams }: { searchParams: { agent_id?: string } }) {
  const { agents, error } = await loadAgents();
  const selected = agents.find((a) => a.agent_id === searchParams.agent_id) ?? agents[0];

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Talk to an agent</h1>
        <p className="text-muted-foreground">
          Hold a test conversation with any agent, including an unpublished draft. Test calls are never billed.
        </p>
      </div>
      {error ? <Alert variant="destructive" data-testid="voice-test-error">{error}</Alert> : null}
      {agents.length === 0 && !error ? (
        <Alert data-testid="voice-test-empty">No voice agents yet. Create one to test it here.</Alert>
      ) : null}
      {agents.length > 0 ? (
        <Card className="grid gap-4 p-4">
          <form method="get" className="flex items-end gap-3">
            <Field label="Agent" htmlFor="agent_id">
              <Select id="agent_id" name="agent_id" defaultValue={selected?.agent_id} data-testid="voice-test-agent">
                {agents.map((a) => (
                  <option key={a.agent_id} value={a.agent_id}>
                    {a.name} {a.published_version_id ? '' : '(draft)'}
                  </option>
                ))}
              </Select>
            </Field>
            <Button type="submit" variant="secondary" data-testid="voice-test-select">Select</Button>
          </form>
          {selected ? <TalkPanel agentId={selected.agent_id} agentName={selected.name} /> : null}
        </Card>
      ) : null}
    </div>
  );
}
