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
import { Alert, Button, Field, Input, Select } from '@projexlight/design-system';

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
    <main className="mx-auto max-w-2xl">
      <h1 className="text-2xl font-bold tracking-tight">Register MCP server</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        On register, the runtime opens the transport and auto-discovers the
        server&apos;s tools. Probe failures roll the registration back to
        <span className="font-mono"> disabled</span>.
      </p>

      {error && <Alert variant="destructive" className="mt-4">{error}</Alert>}

      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-4">
        <Field label="Display name" htmlFor="display_name">
          <Input id="display_name" type="text" required value={displayName}
            onChange={(e) => setDisplayName(e.target.value)} placeholder="acme-slack" />
        </Field>

        <Field label="Transport" htmlFor="transport">
          <Select id="transport" value={transport} onChange={(e) => setTransport(e.target.value as Transport)}>
            <option value="http">HTTP</option>
            <option value="sse" disabled>SSE (v1.1)</option>
            <option value="stdio" disabled>stdio (v1.1)</option>
          </Select>
        </Field>

        <Field label="Endpoint URL" htmlFor="endpoint_url">
          <Input id="endpoint_url" type="url" required value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)} className="font-mono text-xs"
            placeholder="https://slack-mcp.example.com" />
        </Field>

        <Field
          label="Bearer credential"
          htmlFor="credential"
          hint="Base64-encoded client-side, vault-wrapped server-side. Never logged."
        >
          <Input id="credential" type="password" required value={credential}
            onChange={(e) => setCredential(e.target.value)} className="font-mono text-xs"
            autoComplete="new-password" />
        </Field>

        <Field label="Allowed agent IDs (comma-separated, optional)" htmlFor="allowed_agents">
          <Input id="allowed_agents" type="text" value={allowedAgents}
            onChange={(e) => setAllowedAgents(e.target.value)} className="font-mono text-xs"
            placeholder="agent-uuid-1, agent-uuid-2" />
        </Field>

        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={() => router.back()}>Cancel</Button>
          <Button type="submit" disabled={submitting}>
            {submitting ? 'Registering…' : 'Register server'}
          </Button>
        </div>
      </form>
    </main>
  );
}
