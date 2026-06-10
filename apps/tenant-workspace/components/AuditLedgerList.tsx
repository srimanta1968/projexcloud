'use client';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';
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
    return <p className="text-sm text-muted-foreground">No entries yet. Append one above.</p>;
  }
  return (
    <div className="rounded-lg border">
      <Table aria-label="Audit ledger">
        <TableHeader>
          <TableRow>
            <TableHead>Seq</TableHead>
            <TableHead>Entry hash</TableHead>
            <TableHead>Prev hash</TableHead>
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((e) => (
            <TableRow key={e.id} data-seq={e.seq}>
              <TableCell>{e.seq}</TableCell>
              <TableCell><code className="text-xs">{e.entry_hash.slice(0, 16)}...</code></TableCell>
              <TableCell><code className="text-xs">{e.prev_hash ? `${e.prev_hash.slice(0, 16)}...` : '(genesis)'}</code></TableCell>
              <TableCell>{new Date(e.created_at).toLocaleString()}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
