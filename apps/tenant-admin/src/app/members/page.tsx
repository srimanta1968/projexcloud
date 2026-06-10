import { revalidatePath } from 'next/cache';
import {
  Alert,
  Button,
  Input,
  PageHeader,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';
import { StatusBadge } from '../../components/StatusBadge';

interface MemberRow {
  persona_id: string;
  display_name: string;
  role: string | null;
  bu_id: string | null;
  status: string;
}

const TENANT_ID = process.env.TENANT_ADMIN_TENANT_ID ?? '';

async function fetchMembers(): Promise<MemberRow[]> {
  if (!TENANT_ID) return [];
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/personas?tenant_id=${encodeURIComponent(TENANT_ID)}`,
      { cache: 'no-store' },
    );
    if (!res.ok) return [];
    return (await res.json()).data ?? [];
  } catch { return []; }
}

async function updateRole(formData: FormData): Promise<void> {
  'use server';
  const persona_id = String(formData.get('persona_id') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/personas/${encodeURIComponent(persona_id)}/role`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: String(formData.get('role') ?? '') }),
    },
  );
  revalidatePath('/members');
}

async function deactivateAction(formData: FormData): Promise<void> {
  'use server';
  const persona_id = String(formData.get('persona_id') ?? '');
  await fetch(
    `${process.env.NEXT_PUBLIC_GATEWAY_URL}/api/personas/${encodeURIComponent(persona_id)}/deactivate`,
    { method: 'POST' },
  );
  revalidatePath('/members');
}

export default async function MembersPage(): Promise<JSX.Element> {
  const members = await fetchMembers();
  return (
    <div>
      <PageHeader
        title="Members"
        description="Personas in this tenant. Assign roles + BUs; deactivate to revoke access."
      />

      {!TENANT_ID && (
        <Alert variant="warning" className="mb-4">
          Set <code>TENANT_ADMIN_TENANT_ID</code> to view members.
        </Alert>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Persona</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>BU</TableHead>
              <TableHead>Status</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {members.length === 0 && (
              <TableRow><TableCell colSpan={6} className="text-muted-foreground">No members.</TableCell></TableRow>
            )}
            {members.map((m) => (
              <TableRow key={m.persona_id}>
                <TableCell className="font-mono text-[11px]">{m.persona_id}</TableCell>
                <TableCell>{m.display_name}</TableCell>
                <TableCell>
                  <form action={updateRole} className="flex items-center gap-2">
                    <input type="hidden" name="persona_id" value={m.persona_id} />
                    <Input name="role" defaultValue={m.role ?? ''} placeholder="role" className="h-8 w-36" />
                    <Button type="submit" size="sm" variant="secondary">Save</Button>
                  </form>
                </TableCell>
                <TableCell className="text-muted-foreground">{m.bu_id ?? '—'}</TableCell>
                <TableCell><StatusBadge status={m.status} /></TableCell>
                <TableCell>
                  {m.status === 'active' && (
                    <form action={deactivateAction}>
                      <input type="hidden" name="persona_id" value={m.persona_id} />
                      <Button type="submit" size="sm" variant="ghost" className="text-destructive hover:text-destructive">Deactivate</Button>
                    </form>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
