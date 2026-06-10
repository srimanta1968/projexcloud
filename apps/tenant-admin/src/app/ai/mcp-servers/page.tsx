/**
 * Tenant Admin · AI → MCP Servers list page (G-8a / FR-MCP-7).
 *
 * Lists every MCP server the tenant has registered. Pulls from
 * GET /api/mcp/server-registrations?tenant_id=<active>. Tenant id comes
 * from the auth session — for the prototype we read NEXT_PUBLIC_TENANT_ID
 * as a fallback. Empty state directs the admin to the register form.
 */

'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@projexlight/design-system';
import { StatusBadge } from '../../../components/StatusBadge';

interface ServerRow {
  registration_id: string;
  display_name: string;
  transport: 'http' | 'sse' | 'stdio';
  endpoint_url: string;
  status: 'active' | 'disabled' | 'degraded';
  allowed_agent_ids: string[];
  created_at: string;
}

async function fetchServers(tenantId: string): Promise<ServerRow[]> {
  const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? '';
  const res = await fetch(`${apiBase}/api/mcp/server-registrations?tenant_id=${tenantId}`, {
    credentials: 'include',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { success: boolean; data?: ServerRow[]; error?: string };
  if (!body.success) throw new Error(body.error ?? 'unknown');
  return body.data ?? [];
}

export default function McpServersPage(): JSX.Element {
  const tenantId = process.env.NEXT_PUBLIC_TENANT_ID ?? '';
  const [rows, setRows] = useState<ServerRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    fetchServers(tenantId)
      .then((data) => {
        if (mounted) setRows(data);
      })
      .catch((err) => {
        if (mounted) setError((err as Error).message);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [tenantId]);

  return (
    <main className="mx-auto max-w-5xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">MCP Servers</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            External Model Context Protocol servers registered for this tenant.
            Agents reach Slack, Snowflake, Jira and other tools through these.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/ai/mcp-servers/new">Register MCP server</Link>
        </Button>
      </div>

      {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {error && (
        <p className="rounded-md bg-destructive/10 px-4 py-2 text-sm text-destructive">Error: {error}</p>
      )}

      {!loading && !error && rows.length === 0 && (
        <Card className="border-dashed px-8 py-12 text-center">
          <h2 className="text-base font-semibold">No MCP servers registered</h2>
          <p className="mx-auto mt-2 text-sm text-muted-foreground">
            Register your first MCP server to let agents reach external systems.
          </p>
          <Button asChild className="mt-4">
            <Link href="/ai/mcp-servers/new">Register your first server</Link>
          </Button>
        </Card>
      )}

      {!loading && !error && rows.length > 0 && (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Transport</TableHead>
                <TableHead>Endpoint</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Allowed agents</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((s) => (
                <TableRow key={s.registration_id}>
                  <TableCell className="font-medium">{s.display_name}</TableCell>
                  <TableCell className="uppercase text-muted-foreground">{s.transport}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{s.endpoint_url}</TableCell>
                  <TableCell><StatusBadge status={s.status} /></TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {s.allowed_agent_ids.length === 0 ? '—' : `${s.allowed_agent_ids.length} agent(s)`}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{new Date(s.created_at).toLocaleString()}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </main>
  );
}
