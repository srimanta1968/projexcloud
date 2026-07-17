import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  callConnectorTool,
  getInstall,
  getInstallHealth,
  installConnector,
  isKnownConnectorKind,
  listAdapterKinds,
  listDeadLetters,
  listInstalls,
  listToolManifests,
  replayDlq,
  replayDlqForTenant,
  syncConnectorResilient,
  uninstallConnector,
  verifyInboundSignature,
} from '../services/connectorsService';
import { reconcileSyncState, runRetryTick } from '../services/syncRetryWorker';

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
    '/api/connectors/installs/:install_id/health',
    { preHandler: requireAuth },
    async (req, reply) => {
      const health = await getInstallHealth(req.params.install_id);
      if (!health) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { health } });
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
        const result = await syncConnectorResilient(req.params.install_id);
        // Transient sync failures are dead-lettered (202) and retried by the
        // worker; a clean sync returns 200. Only config errors fall through.
        return reply.code(result.status === 'ok' ? 200 : 202).send({ data: result });
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

  // ---- Generic inbound webhook receiver (unauthenticated; signature-gated) ----
  // No requireAuth: inbound webhooks come from external providers, not tenant
  // sessions. The HMAC signature (or the unsigned verification handshake) is the
  // trust boundary.
  app.post<{ Params: { kind: string } }>('/api/connectors/inbound/:kind', async (req, reply) => {
    const kind = req.params.kind;
    if (!isKnownConnectorKind(kind)) {
      return reply.code(404).send({ error: 'UnknownConnectorKind', details: [`no connector kind '${kind}'`] });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Subscription-verification handshake — providers (Slack/Stripe/etc.) send an
    // unsigned challenge when a webhook URL is registered; echo it back.
    if (typeof body.challenge === 'string') {
      return reply.code(200).send({ challenge: body.challenge });
    }

    // Real event delivery must carry a valid HMAC signature.
    const signature = req.headers['x-connector-signature'] as string | undefined;
    if (!verifyInboundSignature(JSON.stringify(body), signature)) {
      return reply.code(401).send({ error: 'InvalidSignature', details: ['missing or invalid x-connector-signature'] });
    }
    const event_type = typeof body.type === 'string' ? body.type : null;
    return reply.code(202).send({ data: { accepted: true, kind, event_type } });
  });

  // ---- Dead-letter queue (DLQ) — sync failures the manifest advertised ----

  app.get<{ Params: { tenant_id: string }; Querystring: { status?: string; connector_kind?: string; limit?: string } }>(
    '/api/connectors/tenants/:tenant_id/dlq',
    { preHandler: requireAuth },
    async (req, reply) => {
      const { status, connector_kind, limit } = req.query;
      const items = await listDeadLetters(req.params.tenant_id, {
        status: status as 'dlq' | 'retrying' | 'resolved' | 'discarded' | undefined,
        connector_kind,
        limit: limit ? Number(limit) : undefined,
      });
      return reply.code(200).send({ data: { deadletters: items } });
    },
  );

  app.post('/api/connectors/dlq/replay', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{ deadletter_id: string; tenant_id: string; connector_kind: string }>;
    try {
      if (body.deadletter_id) {
        const deadletter = await replayDlq({ deadletter_id: body.deadletter_id });
        if (!deadletter) return reply.code(404).send({ error: 'NotFound', details: ['deadletter_id not found or already resolved'] });
        return reply.code(200).send({ data: { deadletter } });
      }
      if (body.tenant_id) {
        const replayed_count = await replayDlqForTenant(body.tenant_id, body.connector_kind);
        return reply.code(200).send({ data: { replayed_count } });
      }
      return reply.code(400).send({ error: 'ValidationError', details: ['provide deadletter_id or tenant_id'] });
    } catch (err) {
      return reply.code(409).send({ error: 'ReplayFailed', details: [(err as Error).message] });
    }
  });

  // Reconcile duplicate / partial DLQ state for a tenant: collapse superseded
  // duplicates and discard orphaned entries whose install is gone.
  app.post<{ Params: { tenant_id: string } }>(
    '/api/connectors/tenants/:tenant_id/dlq/reconcile',
    { preHandler: requireAuth },
    async (req, reply) => {
      const result = await reconcileSyncState(req.params.tenant_id);
      return reply.code(200).send({ data: result });
    },
  );

  // Run one retry-worker tick on demand (drain due dead-letters through backoff).
  // The same logic also runs on a timer when CONNECTORS_RETRY_WORKER_ENABLED.
  app.post<{ Body: { batch_size?: number } }>(
    '/api/connectors/dlq/retry-tick',
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = (req.body ?? {}) as { batch_size?: number };
      const result = await runRetryTick(body.batch_size ?? 20);
      return reply.code(200).send({ data: result });
    },
  );
}
