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
    <main>
      <h1>Append-only Audit Chain</h1>
      <section>
        <h2>Append new entry</h2>
        <AuditEntryForm onAppended={(entry) => setEntries((prev) => [entry, ...prev])} />
      </section>
      <section>
        <h2>Ledger</h2>
        <AuditLedgerList entries={entries} />
      </section>
    </main>
  );
}
