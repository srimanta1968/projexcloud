import Link from 'next/link';
import {
  Badge,
  Button,
  Card,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from '@projexlight/design-system';
import { MarketingHeader } from '../../components/MarketingHeader';
import { MarketingFooter } from '../../components/MarketingFooter';
import {
  PRICING_TIERS,
  PRICING_FEATURES,
  PRICING_OVERAGE,
  PRICING_NOTES,
  type FeatureStatus,
  type PricingFeature,
} from '../../config/pricing';

const STATUS_CELL: Record<FeatureStatus, JSX.Element> = {
  included: <span className="font-semibold text-success">✓</span>,
  addon: <span className="text-muted-foreground">Add-on</span>,
  unavailable: <span className="text-border">—</span>,
  roadmap: <span className="text-warning-foreground">Q3 2026</span>,
};

function renderCell(value: FeatureStatus | string): JSX.Element {
  if (value === 'included' || value === 'addon' || value === 'unavailable' || value === 'roadmap') {
    return STATUS_CELL[value];
  }
  return <span>{value}</span>;
}

function FeatureRow({ row }: { row: PricingFeature }): JSX.Element {
  return (
    <TableRow>
      <TableCell>
        {row.label}
        {row.badge === 'q3-2026' && <Badge variant="warning" className="ml-2">Q3 2026</Badge>}
        {row.badge === 'new' && <Badge variant="success" className="ml-2">New</Badge>}
        {row.badge === 'beta' && <Badge className="ml-2 bg-brand text-brand-foreground">Beta</Badge>}
      </TableCell>
      <TableCell className="text-center">{renderCell(row.starter)}</TableCell>
      <TableCell className="text-center">{renderCell(row.pro)}</TableCell>
      <TableCell className="text-center">{renderCell(row.enterprise)}</TableCell>
    </TableRow>
  );
}

export default function PricingPage(): JSX.Element {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <MarketingHeader />

      <section className="bg-gradient-to-b from-background to-muted px-8 pb-6 pt-[72px] text-center">
        <h1 className="mx-auto mb-3 max-w-2xl text-4xl font-bold tracking-tight">Pricing</h1>
        <p className="mx-auto max-w-xl text-[17px] leading-relaxed text-muted-foreground">
          Three tiers — Starter for evaluation, Pro for production, Enterprise for
          regulated and sovereign deployments. AI tokens billed separately as usage;
          BYOK for AI keys puts that line on your provider invoice.
        </p>
      </section>

      <section className="px-8 pt-6">
        <div className="mx-auto max-w-6xl">
          <div className="mb-14 mt-8 grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
            {PRICING_TIERS.map((tier) => (
              <Card
                key={tier.id}
                className={cn('flex flex-col p-7', tier.highlight && 'border-2 border-brand shadow-md')}
              >
                <div className="mb-2 text-sm font-semibold uppercase tracking-wider text-brand">{tier.name}</div>
                <p className="text-4xl font-bold tracking-tight">{tier.price_monthly}</p>
                <p className="mb-5 mt-1.5 min-h-9 text-xs text-muted-foreground">{tier.price_caption}</p>
                <p className="mb-5 min-h-[60px] text-sm leading-relaxed">{tier.tagline}</p>
                <div className="mt-auto">
                  <Button asChild variant={tier.highlight ? 'primary' : 'secondary'} className="w-full">
                    <Link href={tier.cta_href}>{tier.cta_label}</Link>
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        </div>
      </section>

      <section className="px-8 pb-14 pt-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-1 text-2xl font-bold tracking-tight">Compare plans</h2>
          <p className="mb-4 mt-1 text-sm text-muted-foreground">
            Every tier includes self-serve signup, the six-layer JWT, audit ledger,
            and the 70+ SDK catalog. Differences are about scale, deployment, compliance, and support.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Feature</TableHead>
                {PRICING_TIERS.map((t) => (
                  <TableHead key={t.id} className="text-center">{t.name}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {PRICING_FEATURES.flatMap((group) => [
                <TableRow key={`group-${group.group}`} className="bg-muted hover:bg-muted">
                  <TableCell colSpan={4} className="text-xs font-bold uppercase tracking-wide">
                    {group.group}
                  </TableCell>
                </TableRow>,
                ...group.features.map((row, i) => <FeatureRow key={`${group.group}-${i}`} row={row} />),
              ])}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="bg-muted px-8 pb-14 pt-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-2 text-xl font-bold tracking-tight">Overage rates</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            When you exceed the included quota, the following rates apply automatically.
            Soft-cap warnings stamp on responses before the cap; hard-cap denies past it.
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Resource</TableHead>
                {PRICING_TIERS.map((t) => (
                  <TableHead key={t.id} className="text-center">{t.name}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {PRICING_OVERAGE.map((row, i) => (
                <TableRow key={i}>
                  <TableCell>{row.label}</TableCell>
                  <TableCell className="text-center">{row.starter}</TableCell>
                  <TableCell className="text-center">{row.pro}</TableCell>
                  <TableCell className="text-center">{row.enterprise}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="px-8 pb-16 pt-8">
        <div className="mx-auto max-w-6xl">
          <h2 className="mb-2 text-xl font-bold tracking-tight">Notes</h2>
          <ul className="list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted-foreground">
            {PRICING_NOTES.map((note, i) => <li key={i}>{note}</li>)}
          </ul>
        </div>
      </section>

      <section className="bg-primary px-8 py-16 text-center text-primary-foreground">
        <h2 className="mb-3 text-2xl font-bold tracking-tight">Need a custom deployment?</h2>
        <p className="mx-auto mb-6 max-w-xl text-base text-primary-foreground/70">
          Sovereign regions, FedRAMP-Moderate, HIPAA BAA, on-prem bundles, custom
          SLAs — these live in the Enterprise tier. Tell us what you need.
        </p>
        <Button asChild size="lg" variant="secondary">
          <a href="mailto:sales@projexcloud.com">Talk to sales</a>
        </Button>
      </section>

      <MarketingFooter />
    </div>
  );
}
