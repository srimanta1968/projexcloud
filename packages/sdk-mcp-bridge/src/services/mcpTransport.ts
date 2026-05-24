/**
 * Minimal MCP transport abstraction (FR-MCP-4).
 *
 * The Model Context Protocol defines three transports: HTTP, SSE, and
 * stdio. For prototype scope we ship HTTP end-to-end and stub SSE +
 * stdio behind the same interface so vendor-specific implementations
 * can land later without changing the registration / invocation
 * services.
 */

export type McpTransport = 'http' | 'sse' | 'stdio';

export interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface ListToolsResult {
  tools: McpToolDescriptor[];
}

export interface InvokeResult {
  content: unknown;
  isError?: boolean;
  /** Optional external cost in USD reported by the MCP server (e.g. Snowflake credits). */
  external_cost?: number;
}

export interface TransportClient {
  listTools(): Promise<ListToolsResult>;
  invokeTool(toolName: string, args: unknown): Promise<InvokeResult>;
  close(): Promise<void>;
}

export interface OpenTransportInput {
  transport: McpTransport;
  endpoint_url: string;
  /** Decrypted bearer/OAuth token (or stdio launch env). */
  credential: string;
  timeout_ms?: number;
}

/**
 * Opens a transport client for the given MCP server registration. HTTP
 * is implemented natively; SSE + stdio throw `unsupported_transport`
 * until vendor SDKs are wired (tracked as P6A follow-up).
 */
export async function openTransport(input: OpenTransportInput): Promise<TransportClient> {
  if (input.transport === 'http') return new HttpTransport(input);
  throw new Error(`[mcp-transport] unsupported transport "${input.transport}" — only HTTP is implemented in v0`);
}

class HttpTransport implements TransportClient {
  private readonly endpoint: string;
  private readonly credential: string;
  private readonly timeout_ms: number;

  constructor(input: OpenTransportInput) {
    this.endpoint = input.endpoint_url.replace(/\/$/, '');
    this.credential = input.credential;
    this.timeout_ms = input.timeout_ms ?? 30_000;
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeout_ms);
    try {
      const res = await fetch(`${this.endpoint}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.credential}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        throw new Error(`[mcp-transport] ${path} returned HTTP ${res.status}`);
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(t);
    }
  }

  async listTools(): Promise<ListToolsResult> {
    return this.post<ListToolsResult>('/tools/list', {});
  }

  async invokeTool(toolName: string, args: unknown): Promise<InvokeResult> {
    return this.post<InvokeResult>('/tools/call', { name: toolName, arguments: args });
  }

  async close(): Promise<void> {
    /* http is stateless — no-op */
  }
}
