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

interface ServerRow {
  registration_id: string;
  display_name: string;
  transport: 'http' | 'sse' | 'stdio';
  endpoint_url: string;
  status: 'active' | 'disabled' | 'degraded';
  allowed_agent_ids: string[];
  created_at: string;
}

const STATUS_PILL: Record<ServerRow['status'], string> = {
  active: 'bg-green-100 text-green-800 ring-green-300',
  degraded: 'bg-yellow-100 text-yellow-800 ring-yellow-300',
  disabled: 'bg-zinc-100 text-zinc-600 ring-zinc-300',
};

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
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-900">MCP Servers</h1>
          <p className="mt-1 text-sm text-zinc-500">
            External Model Context Protocol servers registered for this tenant.
            Agents reach Slack, Snowflake, Jira and other tools through these.
          </p>
        </div>
        <Link
          href="/ai/mcp-servers/new"
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Register MCP server
        </Link>
      </div>

      {loading && <p className="text-sm text-zinc-500">Loading…</p>}
      {error && (
        <p className="rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">Error: {error}</p>
      )}

      {!loading && !error && rows.length === 0 && (
        <div className="rounded-lg border border-dashed border-zinc-300 px-8 py-12 text-center">
          <h2 className="text-base font-semibold text-zinc-900">No MCP servers registered</h2>
          <p className="mt-2 text-sm text-zinc-500">
            Register your first MCP server to let agents reach external systems.
          </p>
          <Link
            href="/ai/mcp-servers/new"
            className="mt-4 inline-block rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            Register your first server
          </Link>
        </div>
      )}

      {!loading && !error && rows.length > 0 && (
        <table className="w-full border-collapse text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="px-3 py-2">Name</th>
              <th className="px-3 py-2">Transport</th>
              <th className="px-3 py-2">Endpoint</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Allowed agents</th>
              <th className="px-3 py-2">Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.registration_id} className="border-t border-zinc-200">
                <td className="px-3 py-3 font-medium text-zinc-900">{s.display_name}</td>
                <td className="px-3 py-3 uppercase text-zinc-600">{s.transport}</td>
                <td className="px-3 py-3 font-mono text-xs text-zinc-600">{s.endpoint_url}</td>
                <td className="px-3 py-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_PILL[s.status]}`}
                  >
                    {s.status}
                  </span>
                </td>
                <td className="px-3 py-3 text-xs text-zinc-600">
                  {s.allowed_agent_ids.length === 0 ? '—' : `${s.allowed_agent_ids.length} agent(s)`}
                </td>
                <td className="px-3 py-3 text-xs text-zinc-500">
                  {new Date(s.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
