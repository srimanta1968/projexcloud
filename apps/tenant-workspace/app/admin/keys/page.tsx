'use client';

import { useState } from 'react';
import KeyHierarchyTree, { KeyNode } from '../../../components/KeyHierarchyTree';
import KeyDetailsPanel from '../../../components/KeyDetailsPanel';

// Sample seed for the prototype. In production this loads from sdk-vault.
const SEED: KeyNode[] = [
  { id: 'k1', tier: 1, alias: 'platform-root', status: 'active', purpose: 'KMS root', parent_key_id: null },
  { id: 'k2', tier: 2, alias: 'platform-master', status: 'active', purpose: 'Wraps tenant KEKs', parent_key_id: 'k1' },
  { id: 'k3', tier: 3, alias: 'tenant-acme-kek', status: 'active', purpose: 'Tenant ACME', owner: 'security@acme', parent_key_id: 'k2' },
  { id: 'k4', tier: 4, alias: 'pool-007-kek', status: 'active', parent_key_id: 'k3' },
  { id: 'k5', tier: 5, alias: 'app-engagement', status: 'active', parent_key_id: 'k4' },
  { id: 'k6', tier: 6, alias: 'persona-doctor-42', status: 'active', parent_key_id: 'k5' },
  { id: 'k7', tier: 7, alias: 'dek-encounter-2026-05', status: 'active', parent_key_id: 'k6' },
];

/**
 * /admin/keys — 7-tier key hierarchy management view. Backs scenarios:
 * (1) "Key tiers can be created and linked", (2) "Shred renders keys
 * unrecoverable", (3) "Key metadata persisted".
 */
export default function KeysAdminPage(): JSX.Element {
  const [selected, setSelected] = useState<KeyNode | null>(null);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">7-Tier Key Hierarchy</h1>
      <div className="flex flex-col gap-6 md:flex-row">
        <section className="md:flex-[2]">
          <KeyHierarchyTree keys={SEED} onSelect={setSelected} />
        </section>
        <section className="md:flex-1">
          <KeyDetailsPanel node={selected} />
        </section>
      </div>
    </main>
  );
}
