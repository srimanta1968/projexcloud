'use client';

import { useState } from 'react';

export interface KeyNode {
  id: string;
  tier: number;
  alias: string;
  status: 'active' | 'rotating' | 'retired' | 'shredded';
  purpose?: string;
  owner?: string;
  tags?: Record<string, string>;
  parent_key_id?: string | null;
}

export interface KeyHierarchyTreeProps {
  keys: KeyNode[];
  onSelect?: (key: KeyNode) => void;
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

function buildChildren(keys: KeyNode[], parentId: string | null): KeyNode[] {
  return keys.filter((k) => (k.parent_key_id ?? null) === parentId);
}

function KeyRow({
  node,
  keys,
  depth,
  onSelect,
}: {
  node: KeyNode;
  keys: KeyNode[];
  depth: number;
  onSelect?: (key: KeyNode) => void;
}): JSX.Element {
  const [open, setOpen] = useState(true);
  const children = buildChildren(keys, node.id);
  const hasChildren = children.length > 0;
  const shredded = node.status === 'shredded';

  return (
    <li>
      <div
        style={{ paddingLeft: depth * 16, display: 'flex', gap: 8, alignItems: 'center' }}
        data-key-id={node.id}
        data-tier={node.tier}
        data-status={node.status}
      >
        {hasChildren && (
          <button
            type="button"
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={() => setOpen(!open)}
          >
            {open ? '−' : '+'}
          </button>
        )}
        <span>
          <strong>T{node.tier}</strong> {TIER_NAMES[node.tier] ?? 'Unknown'} —{' '}
          <span style={shredded ? { textDecoration: 'line-through' } : undefined}>{node.alias}</span>
          {' '}<small>({node.status})</small>
        </span>
        {onSelect && (
          <button type="button" onClick={() => onSelect(node)}>
            Details
          </button>
        )}
      </div>
      {hasChildren && open && (
        <ul>
          {children.map((child) => (
            <KeyRow key={child.id} node={child} keys={keys} depth={depth + 1} onSelect={onSelect} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Tree view of the 7-tier key hierarchy. Roots (parent_key_id = null) are
 * rendered at depth 0; children nest under their parent.
 */
export default function KeyHierarchyTree({ keys, onSelect }: KeyHierarchyTreeProps): JSX.Element {
  const roots = buildChildren(keys, null);
  if (roots.length === 0) {
    return <p>No keys configured yet.</p>;
  }
  return (
    <ul aria-label="Key hierarchy">
      {roots.map((root) => (
        <KeyRow key={root.id} node={root} keys={keys} depth={0} onSelect={onSelect} />
      ))}
    </ul>
  );
}
