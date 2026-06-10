'use client';

import { useState } from 'react';
import AuditEntryForm from '../../../components/AuditEntryForm';
import AuditLedgerList from '../../../components/AuditLedgerList';
import { AuditEntry } from '../../../services/auditApi';

/**
 * /admin/audit — append-only audit chain view. Top half is an append form
 * (calls POST /api/audit/append); bottom half shows the entries appended in
 * the current session with their hash-chain links.
 */
export default function AuditAdminPage(): JSX.Element {
  const [entries, setEntries] = useState<AuditEntry[]>([]);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="mb-6 text-2xl font-bold tracking-tight">Append-only Audit Chain</h1>
      <section className="mb-8">
        <h2 className="mb-3 text-lg font-semibold">Append new entry</h2>
        <AuditEntryForm onAppended={(entry) => setEntries((prev) => [entry, ...prev])} />
      </section>
      <section>
        <h2 className="mb-3 text-lg font-semibold">Ledger</h2>
        <AuditLedgerList entries={entries} />
      </section>
    </main>
  );
}
