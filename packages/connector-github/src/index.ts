/**
 * @projexlight/connector-github — public surface.
 *
 * P6A. Bulk operations + webhook ingestion for GitHub. Complements the
 * public GitHub MCP server (most agents reach via sdk-mcp-bridge first).
 * v0 surface (scaffold): migrationsDir only; mirror tables + webhook
 * ingest land in TK-3296.
 */
export { migrationsDir } from './db';
