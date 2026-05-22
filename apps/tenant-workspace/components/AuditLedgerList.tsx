'use client';

import { AuditEntry } from '../services/auditApi';

export interface AuditLedgerListProps {
  entries: AuditEntry[];
}

/**
 * Renders the ledger in append order (newest at top). Each row shows the seq,
 * entry hash, and the prev_hash link so a human can eyeball the chain.
 */
export default function AuditLedgerList({ entries }: AuditLedgerListProps): JSX.Element {
  if (entries.length === 0) {
    return <p>No entries yet. Append one above.</p>;
  }
  return (
    <table aria-label="Audit ledger">
      <thead>
        <tr>
          <th>Seq</th>
          <th>Entry hash</th>
          <th>Prev hash</th>
          <th>Created</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} data-seq={e.seq}>
            <td>{e.seq}</td>
            <td><code>{e.entry_hash.slice(0, 16)}...</code></td>
            <td><code>{e.prev_hash ? `${e.prev_hash.slice(0, 16)}...` : '(genesis)'}</code></td>
            <td>{new Date(e.created_at).toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
