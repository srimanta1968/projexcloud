'use client';

import { useState } from 'react';
import { Button } from '@projexlight/design-system';

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
        className="flex items-center gap-2 rounded-md py-1.5 text-sm hover:bg-muted"
        style={{ paddingLeft: depth * 16 + 4 }}
        data-key-id={node.id}
        data-tier={node.tier}
        data-status={node.status}
      >
        {hasChildren ? (
          <button
            type="button"
            aria-label={open ? 'Collapse' : 'Expand'}
            onClick={() => setOpen(!open)}
            className="flex h-5 w-5 items-center justify-center rounded border text-muted-foreground hover:bg-accent"
          >
            {open ? '−' : '+'}
          </button>
        ) : (
          <span className="inline-block w-5" />
        )}
        <span>
          <span className="font-mono text-xs font-semibold text-muted-foreground">T{node.tier}</span>{' '}
          {TIER_NAMES[node.tier] ?? 'Unknown'} —{' '}
          <span className={shredded ? 'line-through' : 'font-medium'}>{node.alias}</span>{' '}
          <span className="text-xs text-muted-foreground">({node.status})</span>
        </span>
        {onSelect && (
          <Button type="button" variant="ghost" size="sm" className="ml-auto h-7" onClick={() => onSelect(node)}>
            Details
          </Button>
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
    return <p className="text-sm text-muted-foreground">No keys configured yet.</p>;
  }
  return (
    <ul aria-label="Key hierarchy" className="rounded-lg border bg-card p-3">
      {roots.map((root) => (
        <KeyRow key={root.id} node={root} keys={keys} depth={0} onSelect={onSelect} />
      ))}
    </ul>
  );
}
