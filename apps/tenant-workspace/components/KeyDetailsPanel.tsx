'use client';

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
    return <aside aria-label="Key details"><p>Select a key to see its metadata.</p></aside>;
  }
  const tags = node.tags ?? {};
  return (
    <aside aria-label="Key details" data-key-id={node.id}>
      <h2>{node.alias}</h2>
      <dl>
        <dt>Tier</dt>
        <dd>T{node.tier} — {TIER_NAMES[node.tier] ?? 'Unknown'}</dd>
        <dt>Status</dt>
        <dd>{node.status}</dd>
        <dt>Purpose</dt>
        <dd>{node.purpose ?? '—'}</dd>
        <dt>Owner</dt>
        <dd>{node.owner ?? '—'}</dd>
        <dt>Parent key</dt>
        <dd>{node.parent_key_id ?? '(root)'}</dd>
        <dt>Tags</dt>
        <dd>
          {Object.keys(tags).length === 0
            ? '—'
            : Object.entries(tags).map(([k, v]) => (
                <span key={k} style={{ marginRight: 8 }}>{k}={v}</span>
              ))}
        </dd>
      </dl>
    </aside>
  );
}
