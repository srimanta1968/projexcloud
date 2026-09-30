'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { gateway, GatewayError } from '../../../lib/gateway';

/**
 * Agent builder server actions (VA·E9 · TK-4513). Every call runs server-side with the
 * admin's session; outcomes come back to the page as query parameters (redirect), except the
 * voice preview, which returns the audio to the client component that plays it.
 */

const msg = (err: unknown, fallback: string) => (err instanceof GatewayError ? err.message : fallback);
const str = (form: FormData, k: string) => String(form.get(k) ?? '').trim();
const detail = (agentId: string, params: Record<string, string>): never =>
  redirect(`/voice/agents/${encodeURIComponent(agentId)}?${new URLSearchParams(params).toString()}`);

export async function createAgentAction(form: FormData): Promise<void> {
  let agentId = '';
  try {
    const { agent } = await gateway.post<{ agent: { agent_id: string } }>('/api/voice-agent/agents', {
      name: str(form, 'name'),
      direction: str(form, 'direction') || 'inbound',
    });
    agentId = agent.agent_id;
  } catch (err) {
    redirect(`/voice/agents?${new URLSearchParams({ error: msg(err, 'Could not create the agent') })}`);
  }
  revalidatePath('/voice/agents');
  detail(agentId, { created: '1' });
}

/** Clones a preset into a stack profile, binding the chosen key for each slot by reference. */
export async function createStackProfileAction(form: FormData): Promise<void> {
  const agentId = str(form, 'agent_id');
  const credential_refs: Record<string, { primary: string }> = {};
  for (const slot of ['telephony', 'stt', 'llm_fast', 'llm_complex', 'tts']) {
    const binding = str(form, `cred_${slot}`);
    if (binding) credential_refs[slot] = { primary: binding };
  }
  let profileId = '';
  try {
    const { stack_profile } = await gateway.post<{ stack_profile: { profile_id: string } }>('/api/voice-agent/stack-profiles', {
      name: str(form, 'name'),
      preset_key: str(form, 'preset_key'),
      credential_refs,
    });
    profileId = stack_profile.profile_id;
  } catch (err) {
    detail(agentId, { error: msg(err, 'Could not create the stack profile') });
  }
  revalidatePath(`/voice/agents/${agentId}`);
  detail(agentId, { profile: profileId });
}

/** Adds a new immutable version (prompt, greeting, language, stack). */
export async function createVersionAction(form: FormData): Promise<void> {
  const agentId = str(form, 'agent_id');
  let versionNo = '';
  try {
    const { version } = await gateway.post<{ version: { version_no: number } }>(`/api/voice-agent/agents/${encodeURIComponent(agentId)}/versions`, {
      system_prompt: str(form, 'system_prompt'),
      greeting: str(form, 'greeting') || undefined,
      language: str(form, 'language') || 'en-US',
      stack_profile_id: str(form, 'stack_profile_id'),
      tool_ids: [],
    });
    versionNo = String(version.version_no);
  } catch (err) {
    detail(agentId, { error: msg(err, 'Could not save the version') });
  }
  revalidatePath(`/voice/agents/${agentId}`);
  detail(agentId, { version: versionNo });
}

/** Records the result of the admin's own test of a version (suite "manual") — one of the two publish gates. */
/**
 * Starts a simulated-caller run against a version (TK-4518) and opens its result page.
 *   evaluation — the tenant's own LLM keys and tools; a passing one is the first publish gate.
 *   sandbox    — fake providers and a scripted agent: free, checks the plumbing and the app
 *                tools, never unlocks publish.
 * Scenarios are optional JSON (an array); without them the default suite for the mode runs.
 */
export async function startEvalRunAction(form: FormData): Promise<void> {
  const agentId = str(form, 'agent_id');
  const versionId = str(form, 'version_id');
  const mode = str(form, 'mode') === 'sandbox' ? 'sandbox' : 'evaluation';
  const raw = str(form, 'scenarios');
  let scenarios: unknown;
  if (raw) {
    try {
      scenarios = JSON.parse(raw);
    } catch {
      detail(agentId, { error: 'Scenarios must be valid JSON (an array of scenarios).' });
    }
  }
  let runId = '';
  try {
    const { eval_run } = await gateway.post<{ eval_run: { eval_run_id: string } }>(
      `/api/voice-agent/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/eval-runs/start`,
      { mode, ...(scenarios !== undefined ? { scenarios } : {}) },
    );
    runId = eval_run.eval_run_id;
  } catch (err) {
    detail(agentId, { error: msg(err, 'Could not start the evaluation') });
  }
  revalidatePath(`/voice/agents/${agentId}`);
  redirect(`/voice/agents/${encodeURIComponent(agentId)}/evaluations/${encodeURIComponent(runId)}`);
}

/** Opens the approval request for a version on one of the tenant's approval routes — the second gate. */
export async function requestApprovalAction(form: FormData): Promise<void> {
  const agentId = str(form, 'agent_id');
  const versionId = str(form, 'version_id');
  try {
    await gateway.post(`/api/voice-agent/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/publish-request`, {
      route_id: str(form, 'route_id'),
      reason: str(form, 'reason') || 'Publish voice agent version',
    });
  } catch (err) {
    detail(agentId, { error: msg(err, 'Could not request approval') });
  }
  revalidatePath(`/voice/agents/${agentId}`);
  detail(agentId, { requested: versionId });
}

/** Puts a version live — refused (with the unmet gate) unless it passed a test and was approved. */
export async function publishAction(form: FormData): Promise<void> {
  const agentId = str(form, 'agent_id');
  const versionId = str(form, 'version_id');
  try {
    await gateway.post(`/api/voice-agent/agents/${encodeURIComponent(agentId)}/versions/${encodeURIComponent(versionId)}/publish`, {});
  } catch (err) {
    detail(agentId, { error: msg(err, 'Could not publish') });
  }
  revalidatePath(`/voice/agents/${agentId}`);
  detail(agentId, { published: versionId });
}

/** Re-points the agent at a previously published version. */
export async function rollbackAction(form: FormData): Promise<void> {
  const agentId = str(form, 'agent_id');
  try {
    await gateway.post(`/api/voice-agent/agents/${encodeURIComponent(agentId)}/rollback`, { version_id: str(form, 'version_id') });
  } catch (err) {
    detail(agentId, { error: msg(err, 'Could not roll back') });
  }
  revalidatePath(`/voice/agents/${agentId}`);
  detail(agentId, { rolled_back: str(form, 'version_id') });
}

export interface PreviewResult {
  ok: boolean;
  error?: string;
  audio_src?: string;
}

/** Speaks a sample with one of the tenant's TTS keys; returns playable audio to the page. */
export async function previewVoiceAction(input: { binding_id: string; text: string; voice?: string }): Promise<PreviewResult> {
  try {
    const { preview } = await gateway.post<{ preview: { content_type: string; audio_base64: string } }>('/api/speech/voices/preview', {
      binding_id: input.binding_id,
      text: input.text,
      ...(input.voice ? { voice: input.voice } : {}),
    });
    return { ok: true, audio_src: `data:${preview.content_type};base64,${preview.audio_base64}` };
  } catch (err) {
    return { ok: false, error: msg(err, 'Could not preview the voice') };
  }
}
