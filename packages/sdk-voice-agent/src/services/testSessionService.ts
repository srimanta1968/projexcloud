import { dataService } from '@projexlight/db-runtime';
import { conflict, notFound, validationError, VoiceAgentError } from '../models/errors';
import { liveKitConfig, signParticipantToken } from './livekitToken';

/**
 * Browser test sessions (VA·E2 · TK-4476).
 *
 * Lets a builder talk to ANY version of their agent — drafts included — from the
 * browser, with no phone number. A session is an ordinary call row flagged is_test,
 * so the transcript, summary and GET /calls/:call_id work exactly as for a real call,
 * while is_test keeps it out of everything that costs or leaks: it is never metered
 * (the voice-minute meter excludes is_test), and post-call processing does not mirror
 * it onto a real subject's conversation thread or CRM timeline.
 *
 * The browser gets a LiveKit token for a room named after the call; the token asks
 * LiveKit to dispatch the voice-runtime worker with the call/version it must run.
 */

export interface StartTestSessionInput {
  agent_id?: unknown;
  version_id?: unknown;
  ttl_s?: unknown;
}

export interface TestSession {
  call_id: string;
  agent_id: string;
  agent_version_id: string;
  version_no: number;
  room: string;
  livekit_url: string;
  token: string;
  expires_at: string;
  is_test: true;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TTL_S = 900;
const MIN_TTL_S = 60;
const MAX_TTL_S = 3600;

/**
 * Opens a test session against a version of the tenant's agent (latest when
 * version_id is omitted).
 *
 * @throws VoiceAgentError 400 invalid input, 404 unknown agent/version, 409 archived
 *   agent / no version / inactive stack profile, 503 voice media not configured.
 */
export async function startTestSession(tenantId: string, input: StartTestSessionInput, testerId: string): Promise<TestSession> {
  if (typeof input.agent_id !== 'string' || !UUID_RE.test(input.agent_id)) throw validationError('agent_id must be a uuid');
  if (input.version_id !== undefined && input.version_id !== null && (typeof input.version_id !== 'string' || !UUID_RE.test(input.version_id))) {
    throw validationError('version_id must be a uuid');
  }
  const ttl = input.ttl_s ?? DEFAULT_TTL_S;
  if (!Number.isInteger(ttl) || (ttl as number) < MIN_TTL_S || (ttl as number) > MAX_TTL_S) {
    throw validationError(`ttl_s must be an integer between ${MIN_TTL_S} and ${MAX_TTL_S}`);
  }

  const agent = await dataService.one<{ agent_id: string; status: string }>(
    `SELECT agent_id, status FROM voice_agent.agent WHERE tenant_id = $1 AND agent_id = $2`,
    [tenantId, input.agent_id],
  );
  if (!agent) throw notFound('agent not found');
  if (agent.status === 'archived') throw conflict('agent is archived');

  const version = await dataService.one<{ version_id: string; version_no: number; profile_status: string | null }>(
    `SELECT v.version_id, v.version_no, sp.status AS profile_status
       FROM voice_agent.agent_version v
       LEFT JOIN voice_agent.stack_profile sp ON sp.profile_id = v.stack_profile_id AND sp.tenant_id = v.tenant_id
      WHERE v.tenant_id = $1 AND v.agent_id = $2 AND ($3::uuid IS NULL OR v.version_id = $3::uuid)
      ORDER BY v.version_no DESC
      LIMIT 1`,
    [tenantId, input.agent_id, (input.version_id as string | undefined) ?? null],
  );
  if (!version) {
    if (input.version_id) throw notFound('agent version not found');
    throw conflict('agent has no versions to test');
  }
  if (version.profile_status !== 'active') throw conflict("the version's stack profile is not active");

  // Checked last so a misconfigured deployment still reports caller mistakes first.
  const lk = liveKitConfig();
  if (!lk) throw new VoiceAgentError(503, 'VoiceRuntimeUnavailable', 'voice media (LiveKit) is not configured on this deployment');

  const call = await dataService.one<{ call_id: string }>(
    `INSERT INTO voice_agent.call (tenant_id, agent_id, agent_version_id, direction, is_test, requested_by, context)
     VALUES ($1, $2, $3, 'inbound', true, $4, $5::jsonb)
     RETURNING call_id`,
    [tenantId, input.agent_id, version.version_id, testerId, JSON.stringify({ test_session: true })],
  );
  if (!call) throw new Error('[sdk-voice-agent] test session insert returned no row');

  const room = `va-test-${call.call_id}`;
  await dataService.query(
    `UPDATE voice_agent.call SET context = context || $3::jsonb WHERE tenant_id = $1 AND call_id = $2`,
    [tenantId, call.call_id, JSON.stringify({ room })],
  );
  const { token, expiresAt } = signParticipantToken(lk, {
    identity: `tester:${testerId}`,
    room,
    ttlSeconds: ttl as number,
    metadata: { role: 'tester' },
    agentMetadata: {
      tenant_id: tenantId, call_id: call.call_id, agent_id: input.agent_id, agent_version_id: version.version_id, is_test: true,
    },
  });
  return {
    call_id: call.call_id,
    agent_id: input.agent_id,
    agent_version_id: version.version_id,
    version_no: version.version_no,
    room,
    livekit_url: lk.url,
    token,
    expires_at: expiresAt,
    is_test: true,
  };
}
