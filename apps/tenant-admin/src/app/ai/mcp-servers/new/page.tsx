/**
 * Tenant Admin · AI → MCP Servers → Register form (G-8b / FR-MCP-8).
 *
 * Form fields: display_name, transport (http/sse/stdio), endpoint_url,
 * credential (sent base64-encoded as credential_envelope_b64),
 * allowed_agent_ids (comma-separated). POST /api/mcp/server-registrations.
 * On success → redirect to /ai/mcp-servers.
 *
 * Credential is base64-encoded client-side rather than sent as plain text
 * over the wire — the api-gateway already runs HTTPS in prod, but the
 * encoding is a defensive measure for browser-extension log scrapers.
 */

'use client';

import { useRouter } from 'next/navigation';
import { FormEvent, useState } from 'react';

type Transport = 'http' | 'sse' | 'stdio';

interface RegisterResponse {
  success: boolean;
  data?: { server: { registration_id: string } };
  error?: string;
}

export default function RegisterMcpServerPage(): JSX.Element {
  const router = useRouter();
  const tenantId = process.env.NEXT_PUBLIC_TENANT_ID ?? '';
  const apiBase = process.env.NEXT_PUBLIC_API_BASE ?? '';
  const [displayName, setDisplayName] = useState('');
  const [transport, setTransport] = useState<Transport>('http');
  const [endpointUrl, setEndpointUrl] = useState('');
  const [credential, setCredential] = useState('');
  const [allowedAgents, setAllowedAgents] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const body = {
        tenant_id: tenantId,
        display_name: displayName.trim(),
        transport,
        endpoint_url: endpointUrl.trim(),
        credential_envelope_b64: btoa(credential),
        allowed_agent_ids: allowedAgents
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      };
      const res = await fetch(`${apiBase}/api/mcp/server-registrations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = (await res.json()) as RegisterResponse;
      if (!res.ok || !payload.success) {
        throw new Error(payload.error ?? `HTTP ${res.status}`);
      }
      router.push('/ai/mcp-servers');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-8">
      <h1 className="text-2xl font-semibold text-zinc-900">Register MCP server</h1>
      <p className="mt-1 text-sm text-zinc-500">
        On register, the runtime opens the transport and auto-discovers the
        server's tools. Probe failures roll the registration back to
        <span className="font-mono"> disabled</span>.
      </p>

      {error && (
        <p className="mt-4 rounded-md bg-red-50 px-4 py-2 text-sm text-red-700">
          {error}
        </p>
      )}

      <form onSubmit={handleSubmit} className="mt-6 space-y-5">
        <div>
          <label htmlFor="display_name" className="block text-sm font-medium text-zinc-900">
            Display name
          </label>
          <input
            id="display_name"
            type="text"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            className="mt-1 block w-full rounded-md border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            placeholder="acme-slack"
          />
        </div>

        <div>
          <label htmlFor="transport" className="block text-sm font-medium text-zinc-900">
            Transport
          </label>
          <select
            id="transport"
            value={transport}
            onChange={(e) => setTransport(e.target.value as Transport)}
            className="mt-1 block w-full rounded-md border-zinc-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
          >
            <option value="http">HTTP</option>
            <option value="sse" disabled>SSE (v1.1)</option>
            <option value="stdio" disabled>stdio (v1.1)</option>
          </select>
        </div>

        <div>
          <label htmlFor="endpoint_url" className="block text-sm font-medium text-zinc-900">
            Endpoint URL
          </label>
          <input
            id="endpoint_url"
            type="url"
            required
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            className="mt-1 block w-full rounded-md border-zinc-300 px-3 py-2 font-mono text-xs shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            placeholder="https://slack-mcp.example.com"
          />
        </div>

        <div>
          <label htmlFor="credential" className="block text-sm font-medium text-zinc-900">
            Bearer credential
          </label>
          <input
            id="credential"
            type="password"
            required
            value={credential}
            onChange={(e) => setCredential(e.target.value)}
            className="mt-1 block w-full rounded-md border-zinc-300 px-3 py-2 font-mono text-xs shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            autoComplete="new-password"
          />
          <p className="mt-1 text-xs text-zinc-500">
            Base64-encoded client-side, vault-wrapped server-side. Never logged.
          </p>
        </div>

        <div>
          <label htmlFor="allowed_agents" className="block text-sm font-medium text-zinc-900">
            Allowed agent IDs (comma-separated, optional)
          </label>
          <input
            id="allowed_agents"
            type="text"
            value={allowedAgents}
            onChange={(e) => setAllowedAgents(e.target.value)}
            className="mt-1 block w-full rounded-md border-zinc-300 px-3 py-2 font-mono text-xs shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
            placeholder="agent-uuid-1, agent-uuid-2"
          />
        </div>

        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-md border border-zinc-300 bg-white px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {submitting ? 'Registering…' : 'Register server'}
          </button>
        </div>
      </form>
    </main>
  );
}
