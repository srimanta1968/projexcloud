import { Alert, Button, Card, Field, Input, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@projexlight/design-system';
import { gateway, GatewayError } from '../../../lib/gateway';
import { bindNumberAction, unbindNumberAction } from '../campaigns/actions';

/**
 * Phone numbers (VA·E9 · TK-4514): bind an inbound number to an agent — calls to it are
 * answered by that agent, and when the agent cannot take a call (killed, over capacity) the
 * fallback applies — and unbind it again.
 */

interface Agent { agent_id: string; name: string }
interface Binding { binding_id: string; phone_number: string; carrier: string; fallback: string; fallback_target: string | null; active: boolean }

export default async function VoiceNumbersPage({ searchParams }: { searchParams: { error?: string; bound?: string; unbound?: string } }) {
  let agents: Agent[] = [];
  let error = searchParams.error;
  const rows: (Binding & { agent: Agent })[] = [];
  try {
    agents = (await gateway.get<{ agents: Agent[] }>('/api/voice-agent/agents?limit=200')).agents;
    const lists = await Promise.all(agents.map(async (a) => {
      const r = await gateway.get<{ bindings: Binding[] }>(`/api/voice-agent/agents/${encodeURIComponent(a.agent_id)}/numbers`).catch(() => ({ bindings: [] as Binding[] }));
      return r.bindings.map((b) => ({ ...b, agent: a }));
    }));
    rows.push(...lists.flat());
  } catch (err) {
    error = err instanceof GatewayError ? err.message : 'Could not load numbers';
  }

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">Phone numbers</h1>
        <p className="text-muted-foreground">Bind a number to an agent so it answers calls to that number.</p>
      </div>
      {error ? <Alert variant="destructive" data-testid="voice-numbers-error">{error}</Alert> : null}
      {searchParams.bound ? <Alert variant="success" data-testid="voice-numbers-bound">Number {searchParams.bound} bound.</Alert> : null}
      {searchParams.unbound ? <Alert variant="success">Number unbound.</Alert> : null}

      <Card className="grid gap-3 p-4">
        <h2 className="text-lg font-semibold">Bind a number</h2>
        {agents.length === 0 ? <p className="text-muted-foreground">Create an agent first.</p> : (
          <form action={bindNumberAction} className="grid gap-3 md:grid-cols-5 md:items-end">
            <Field label="Agent" htmlFor="agent_id">
              <Select id="agent_id" name="agent_id" required>
                {agents.map((a) => <option key={a.agent_id} value={a.agent_id}>{a.name}</option>)}
              </Select>
            </Field>
            <Field label="Phone number" htmlFor="phone_number" hint="E.164, e.g. +14155550100">
              <Input id="phone_number" name="phone_number" required pattern="\+[1-9][0-9]{6,14}" placeholder="+14155550100" />
            </Field>
            <Field label="Carrier" htmlFor="carrier">
              <Select id="carrier" name="carrier" defaultValue="twilio">
                <option value="twilio">twilio</option>
                <option value="telnyx">telnyx</option>
                <option value="sip">sip</option>
              </Select>
            </Field>
            <Field label="When the agent can't answer" htmlFor="fallback">
              <Select id="fallback" name="fallback" defaultValue="voicemail">
                <option value="voicemail">voicemail</option>
                <option value="forward">forward to a number</option>
                <option value="ivr">IVR</option>
              </Select>
            </Field>
            <Field label="Forward to" htmlFor="fallback_target" hint="Only for forward">
              <Input id="fallback_target" name="fallback_target" placeholder="+14155550199" />
            </Field>
            <Button type="submit" data-testid="voice-numbers-bind">Bind number</Button>
          </form>
        )}
      </Card>

      <Card className="p-4">
        {rows.length === 0 ? <p className="text-muted-foreground" data-testid="voice-numbers-empty">No numbers bound yet.</p> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead>
                <TableHead>Agent</TableHead>
                <TableHead>Carrier</TableHead>
                <TableHead>Fallback</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={b.binding_id} data-testid={`number-${b.phone_number}`}>
                  <TableCell className="font-mono">{b.phone_number}</TableCell>
                  <TableCell>{b.agent.name}</TableCell>
                  <TableCell>{b.carrier}</TableCell>
                  <TableCell>{b.fallback}{b.fallback_target ? ` → ${b.fallback_target}` : ''}</TableCell>
                  <TableCell>
                    <form action={unbindNumberAction}>
                      <input type="hidden" name="agent_id" value={b.agent.agent_id} />
                      <input type="hidden" name="binding_id" value={b.binding_id} />
                      <Button type="submit" size="sm" variant="secondary">Unbind</Button>
                    </form>
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
