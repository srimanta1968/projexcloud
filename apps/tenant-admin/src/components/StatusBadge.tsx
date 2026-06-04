import { Badge, cn } from '@projexlight/design-system';

/**
 * Uniform status pill for the tenant-admin tables. Green = healthy/active,
 * amber = pending/transitional, grey = inactive/revoked, red = failed.
 */
const STATUS_CLASS: Record<string, string> = {
  active: 'bg-green-50 text-green-700 border-green-200',
  enabled: 'bg-green-50 text-green-700 border-green-200',
  granted: 'bg-green-50 text-green-700 border-green-200',
  approved: 'bg-green-50 text-green-700 border-green-200',
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  rotating: 'bg-amber-50 text-amber-700 border-amber-200',
  degraded: 'bg-amber-50 text-amber-700 border-amber-200',
  revoking: 'bg-amber-50 text-amber-700 border-amber-200',
  revoked: 'bg-muted text-muted-foreground border-border',
  disabled: 'bg-muted text-muted-foreground border-border',
  inactive: 'bg-muted text-muted-foreground border-border',
  failed: 'bg-red-50 text-red-700 border-red-200',
  rejected: 'bg-red-50 text-red-700 border-red-200',
  error: 'bg-red-50 text-red-700 border-red-200',
};

export function StatusBadge({ status }: { status: string }): JSX.Element {
  return (
    <Badge
      variant="outline"
      className={cn('uppercase tracking-wide', STATUS_CLASS[status?.toLowerCase()] ?? 'bg-muted text-muted-foreground border-border')}
    >
      {status}
    </Badge>
  );
}
