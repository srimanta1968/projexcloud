import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  callConnectorTool,
  getInstall,
  installConnector,
  listAdapterKinds,
  listInstalls,
  listToolManifests,
  syncConnector,
  uninstallConnector,
} from '../services/connectorsService';

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/connectors/kinds', { preHandler: requireAuth }, async (_req, reply) => {
    return reply.code(200).send({ data: { kinds: listAdapterKinds() } });
  });

  app.post('/api/connectors/installs', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string;
      connector_kind: string;
      display_name: string;
      credential_ref: string;
      vendor_account_id: string;
      installed_by: string;
    }>;
    if (!body.tenant_id || !body.connector_kind || !body.installed_by) {
      return reply.code(400).send({ error: 'ValidationError', details: ['missing fields'] });
    }
    const rec = await installConnector({
      tenant_id: body.tenant_id,
      connector_kind: body.connector_kind,
      display_name: body.display_name,
      credential_ref: body.credential_ref,
      vendor_account_id: body.vendor_account_id,
      installed_by: body.installed_by,
    });
    return reply.code(201).send({ data: { install: rec } });
  });

  app.get<{ Params: { tenant_id: string } }>(
    '/api/connectors/tenants/:tenant_id/installs',
    { preHandler: requireAuth },
    async (req, reply) => {
      const recs = await listInstalls(req.params.tenant_id);
      return reply.code(200).send({ data: { installs: recs } });
    },
  );

  app.get<{ Params: { install_id: string } }>(
    '/api/connectors/installs/:install_id',
    { preHandler: requireAuth },
    async (req, reply) => {
      const rec = await getInstall(req.params.install_id);
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { install: rec } });
    },
  );

  app.post<{ Params: { install_id: string } }>(
    '/api/connectors/installs/:install_id/uninstall',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ actor_id: string }>;
      const rec = await uninstallConnector(req.params.install_id, body.actor_id ?? 'unknown');
      if (!rec) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { install: rec } });
    },
  );

  app.get<{ Params: { install_id: string } }>(
    '/api/connectors/installs/:install_id/tools',
    { preHandler: requireAuth },
    async (req, reply) => {
      const tools = await listToolManifests(req.params.install_id);
      return reply.code(200).send({ data: { tools } });
    },
  );

  app.post<{ Params: { install_id: string } }>(
    '/api/connectors/installs/:install_id/sync',
    { preHandler: requireAuth },
    async (req, reply) => {
      try {
        const result = await syncConnector(req.params.install_id);
        return reply.code(200).send({ data: result });
      } catch (err) {
        return reply.code(409).send({ error: 'SyncFailed', details: [(err as Error).message] });
      }
    },
  );

  app.post<{ Params: { install_id: string } }>(
    '/api/connectors/installs/:install_id/tools/call',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body as Partial<{ tool_name: string; args: Record<string, unknown> }>;
      if (!body.tool_name) {
        return reply.code(400).send({ error: 'ValidationError', details: ['missing tool_name'] });
      }
      try {
        const result = await callConnectorTool(req.params.install_id, body.tool_name, body.args ?? {});
        return reply.code(200).send({ data: { result } });
      } catch (err) {
        return reply.code(409).send({ error: 'ToolCallFailed', details: [(err as Error).message] });
      }
    },
  );
}
