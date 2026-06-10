import { revalidatePath } from 'next/cache';
import {
  Button,
  Card,
  Field,
  Input,
  Label,
  PageHeader,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';
import { StatusBadge } from '../../components/StatusBadge';

interface RegionRow {
  region_id: string;
  regime: 'fedramp-high' | 'il5' | 'pipl' | 'eu-sovereign' | 'uae-trd';
  operator_partner: string;
  terminal_federation: boolean;
  kms_provider: string;
  activated_at: string;
  attestation_state: 'in-progress' | 'attested' | 'expired';
}

async function fetchRegions(): Promise<RegionRow[]> {
  try {
    const res = await fetch(
      `${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/sovereign/regions`,
      {
        cache: 'no-store',
        headers: { 'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '' },
      },
    );
    if (!res.ok) return [];
    const body = await res.json();
    return body.data ?? [];
  } catch {
    return [];
  }
}

async function registerRegionAction(formData: FormData): Promise<void> {
  'use server';
  await fetch(`${process.env.NEXT_PUBLIC_GATEWAY_URL}/admin/sovereign/regions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-ops-token': process.env.ADMIN_OPS_TOKEN ?? '',
    },
    body: JSON.stringify({
      region_id: String(formData.get('region_id') ?? ''),
      regime: String(formData.get('regime') ?? ''),
      operator_partner: String(formData.get('operator_partner') ?? ''),
      terminal_federation: formData.get('terminal_federation') === 'on',
      kms_provider: String(formData.get('kms_provider') ?? ''),
      operator_id: 'admin-ui',
    }),
  });
  revalidatePath('/sovereign-regions');
}

export default async function SovereignRegionsPage(): Promise<JSX.Element> {
  const regions = await fetchRegions();
  return (
    <div>
      <PageHeader
        title="Sovereign regions"
        description={
          <>
            P8 Variant B. Isolated regions (FedRAMP-High / IL5 / PIPL / EU sovereign / UAE TRD).
            Pool Router federation manifest treats <code>terminal_federation=true</code> regions as terminal —
            cross-region routes targeting them are refused with HTTP 451.
          </>
        }
      />

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Region</TableHead>
              <TableHead>Regime</TableHead>
              <TableHead>Operator</TableHead>
              <TableHead>Terminal</TableHead>
              <TableHead>KMS</TableHead>
              <TableHead>Attestation</TableHead>
              <TableHead>Activated</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {regions.length === 0 && (
              <TableRow><TableCell colSpan={7} className="text-muted-foreground">No regions registered. Add one below.</TableCell></TableRow>
            )}
            {regions.map((r) => (
              <TableRow key={r.region_id}>
                <TableCell className="font-mono text-xs">{r.region_id}</TableCell>
                <TableCell>{r.regime}</TableCell>
                <TableCell>{r.operator_partner}</TableCell>
                <TableCell>{r.terminal_federation ? 'yes' : 'no'}</TableCell>
                <TableCell>{r.kms_provider}</TableCell>
                <TableCell><StatusBadge status={r.attestation_state} /></TableCell>
                <TableCell className="text-muted-foreground">{new Date(r.activated_at).toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Card className="mt-8 max-w-2xl p-5">
        <h2 className="mb-4 text-lg font-semibold">Register a sovereign region</h2>
        <form action={registerRegionAction} className="grid gap-3.5">
          <Field label="Region ID" htmlFor="region_id">
            <Input id="region_id" name="region_id" required placeholder="us-gov-east-1" />
          </Field>
          <Field label="Regime" htmlFor="regime">
            <Select id="regime" name="regime" required>
              <option value="fedramp-high">FedRAMP-High</option>
              <option value="il5">IL5</option>
              <option value="pipl">PIPL (China)</option>
              <option value="eu-sovereign">EU sovereign</option>
              <option value="uae-trd">UAE TRD</option>
            </Select>
          </Field>
          <Field label="Operator partner" htmlFor="operator_partner">
            <Input id="operator_partner" name="operator_partner" required />
          </Field>
          <Field label="KMS provider" htmlFor="kms_provider">
            <Input id="kms_provider" name="kms_provider" required />
          </Field>
          <Label className="flex items-center gap-2">
            <input type="checkbox" name="terminal_federation" defaultChecked className="h-4 w-4" /> Terminal federation (refuse cross-region routes)
          </Label>
          <Button type="submit" className="justify-self-start">Register region</Button>
        </form>
      </Card>
    </div>
  );
}
