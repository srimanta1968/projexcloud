import { Badge, cn } from '@projexlight/design-system';

/**
 * Uniform status pill for the console tables. Maps the various lifecycle /
 * attestation states the gateway returns to a consistent colour language:
 * green = healthy/active, amber = transitional, grey = retired, red = failed.
 */
const STATUS_CLASS: Record<string, string> = {
  active: 'bg-green-50 text-green-700 border-green-200',
  attested: 'bg-green-50 text-green-700 border-green-200',
  draining: 'bg-amber-50 text-amber-700 border-amber-200',
  draft: 'bg-amber-50 text-amber-700 border-amber-200',
  quiesced: 'bg-amber-50 text-amber-700 border-amber-200',
  'in-progress': 'bg-amber-50 text-amber-700 border-amber-200',
  retired: 'bg-muted text-muted-foreground border-border',
  expired: 'bg-red-50 text-red-700 border-red-200',
};

export function StatusBadge({ status }: { status: string }): JSX.Element {
  return (
    <Badge
      variant="outline"
      className={cn('uppercase tracking-wide', STATUS_CLASS[status] ?? 'bg-muted text-muted-foreground border-border')}
    >
      {status}
    </Badge>
  );
}
