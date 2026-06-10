'use client';

import { Card } from '@projexlight/design-system';
import { KeyNode } from './KeyHierarchyTree';

export interface KeyDetailsPanelProps {
  node: KeyNode | null;
}

const TIER_NAMES: Record<number, string> = {
  1: 'Root',
  2: 'Master',
  3: 'Tenant KEK',
  4: 'Pool KEK',
  5: 'App',
  6: 'Persona',
  7: 'Data Encryption Key',
};

/**
 * Right-rail details panel for a selected key. Displays metadata (alias, tier,
 * purpose, owner, tags) — the same fields the persistence acceptance criterion
 * exercises.
 */
export default function KeyDetailsPanel({ node }: KeyDetailsPanelProps): JSX.Element {
  if (!node) {
    return (
      <aside aria-label="Key details">
        <Card className="p-4 text-sm text-muted-foreground">Select a key to see its metadata.</Card>
      </aside>
    );
  }
  const tags = node.tags ?? {};
  const rows: Array<[string, React.ReactNode]> = [
    ['Tier', `T${node.tier} — ${TIER_NAMES[node.tier] ?? 'Unknown'}`],
    ['Status', node.status],
    ['Purpose', node.purpose ?? '—'],
    ['Owner', node.owner ?? '—'],
    ['Parent key', node.parent_key_id ?? '(root)'],
    [
      'Tags',
      Object.keys(tags).length === 0
        ? '—'
        : Object.entries(tags).map(([k, v]) => (
            <span key={k} className="mr-2 font-mono text-xs">{k}={v}</span>
          )),
    ],
  ];
  return (
    <aside aria-label="Key details" data-key-id={node.id}>
      <Card className="p-4">
        <h2 className="mb-3 text-lg font-semibold">{node.alias}</h2>
        <dl className="space-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="grid grid-cols-[110px_1fr] gap-2">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </aside>
  );
}
