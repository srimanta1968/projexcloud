import Link from 'next/link';
import { Alert, Badge, Button, Card, Field, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea } from '@projexlight/design-system';
import { gateway, GatewayError } from '../../../../lib/gateway';
import { transitionCampaignAction, uploadContactsAction } from '../actions';

/**
 * One campaign (VA·E9 · TK-4514): progress by contact status, contact upload, and the
 * lifecycle controls — start (draft), pause (running), resume (paused), cancel.
 */

interface Campaign {
  campaign_id: string; agent_id: string; name: string; status: string; window_start: string; window_end: string;
  default_timezone: string; max_concurrency: number; max_attempts: number;
  progress: { total: number; by_status: Record<string, number> };
}
interface Contact { contact_id: string; external_ref: string | null; phone_number: string; status: string; attempts: number; next_attempt_at?: string | null }

const ACTIONS: Record<string, { action: string; label: string; variant: 'primary' | 'secondary' | 'danger' }[]> = {
  draft: [{ action: 'start', label: 'Start', variant: 'primary' }, { action: 'cancel', label: 'Cancel campaign', variant: 'danger' }],
  running: [{ action: 'pause', label: 'Pause', variant: 'secondary' }, { action: 'cancel', label: 'Cancel campaign', variant: 'danger' }],
  paused: [{ action: 'resume', label: 'Resume', variant: 'primary' }, { action: 'cancel', label: 'Cancel campaign', variant: 'danger' }],
};

export default async function CampaignPage({ params, searchParams }: { params: { campaign_id: string }; searchParams: Record<string, string | undefined> }) {
  const id = encodeURIComponent(params.campaign_id);
  let campaign: Campaign;
  let contacts: Contact[] = [];
  try {
    [campaign, contacts] = await Promise.all([
      gateway.get<{ campaign: Campaign }>(`/api/dialer/campaigns/${id}`).then((r) => r.campaign),
      gateway.get<{ contacts: Contact[] }>(`/api/dialer/campaigns/${id}/contacts?limit=200`).then((r) => r.contacts).catch(() => [] as Contact[]),
    ]);
  } catch (err) {
    return <Alert variant="destructive" data-testid="campaign-error">{err instanceof GatewayError ? err.message : 'Could not load the campaign'}</Alert>;
  }
  const byStatus = Object.entries(campaign.progress?.by_status ?? {});

  return (
    <div className="grid gap-6">
      <div>
        <Link href="/voice/campaigns" className="text-sm text-muted-foreground">← Campaigns</Link>
        <h1 className="text-2xl font-semibold" data-testid="campaign-name">{campaign.name}</h1>
        <p className="text-muted-foreground">
          <Badge variant={campaign.status === 'running' ? 'success' : campaign.status === 'paused' ? 'warning' : 'secondary'} data-testid="campaign-status">
            {campaign.status}
          </Badge>{' '}
          calls {campaign.window_start}–{campaign.window_end} recipient-local (default {campaign.default_timezone}) · up to {campaign.max_concurrency} at once ·{' '}
          {campaign.max_attempts} attempts per contact
        </p>
      </div>
      {searchParams.error ? <Alert variant="destructive" data-testid="campaign-action-error">{searchParams.error}</Alert> : null}
      {searchParams.created ? <Alert variant="success">Campaign created. Upload contacts, then start it.</Alert> : null}
      {searchParams.did ? <Alert variant="success" data-testid="campaign-did">Campaign {searchParams.did === 'start' ? 'started' : `${searchParams.did}d`}.</Alert> : null}
      {searchParams.uploaded !== undefined ? (
        <Alert variant={searchParams.rejected && searchParams.rejected !== '0' ? 'warning' : 'success'} data-testid="campaign-uploaded">
          {searchParams.uploaded} added, {searchParams.updated ?? 0} updated, {searchParams.rejected ?? 0} rejected{searchParams.reasons ? ` (${searchParams.reasons})` : ''}.
        </Alert>
      ) : null}

      <Card className="flex flex-wrap items-center gap-3 p-4" data-testid="campaign-controls">
        {(ACTIONS[campaign.status] ?? []).map((a) => (
          <form key={a.action} action={transitionCampaignAction}>
            <input type="hidden" name="campaign_id" value={campaign.campaign_id} />
            <input type="hidden" name="action" value={a.action} />
            <Button type="submit" variant={a.variant} data-testid={`campaign-${a.action}`}>{a.label}</Button>
          </form>
        ))}
        {(ACTIONS[campaign.status] ?? []).length === 0 ? <span className="text-muted-foreground">This campaign is {campaign.status}.</span> : null}
      </Card>

      <Card className="grid gap-2 p-4" data-testid="campaign-progress">
        <h2 className="text-lg font-semibold">Progress</h2>
        <p>{campaign.progress?.total ?? 0} contacts</p>
        <div className="flex flex-wrap gap-2">
          {byStatus.length === 0 ? <span className="text-muted-foreground">No contacts yet.</span> : byStatus.map(([s, n]) => <Badge key={s} variant="outline">{s}: {n}</Badge>)}
        </div>
      </Card>

      {campaign.status !== 'cancelled' && campaign.status !== 'completed' ? (
        <Card className="grid gap-3 p-4">
          <h2 className="text-lg font-semibold">Add contacts</h2>
          <form action={uploadContactsAction} className="grid gap-3">
            <input type="hidden" name="campaign_id" value={campaign.campaign_id} />
            <Field label="One per line: phone_number,subject_ref,timezone,person_id" htmlFor="contacts" hint="Only the E.164 phone number is required. Calls need the person's ai_voice_outbound consent.">
              <Textarea id="contacts" name="contacts" rows={5} placeholder={'+14155550101,lead:101,America/Chicago\n+14155550102'} />
            </Field>
            <div><Button type="submit" variant="secondary" data-testid="campaign-upload">Upload contacts</Button></div>
          </form>
        </Card>
      ) : null}

      <Card className="p-4">
        {contacts.length === 0 ? <p className="text-muted-foreground">No contacts.</p> : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Phone</TableHead>
                <TableHead>Reference</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contacts.map((c) => (
                <TableRow key={c.contact_id}>
                  <TableCell className="font-mono">{c.phone_number}</TableCell>
                  <TableCell>{c.external_ref ?? '—'}</TableCell>
                  <TableCell>{c.status}</TableCell>
                  <TableCell>{c.attempts}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
