import { dataService } from '@projexlight/db-runtime';
import { listTenantCredentials } from '@projexlight/sdk-ai-gateway';
import {
  VOICE_LAYERS,
  findPreset,
  isVoiceLayer,
  type LayerConfig,
  type LayerMap,
  type PresetKey,
  type VoiceLayer,
} from '../models/presets';
import { VoiceAgentError, conflict, notFound, validationError } from '../models/errors';

/**
 * Stack profiles (VA·E2, TK-4469): a tenant's concrete provider stack, cloned from a
 * preset and overridden per layer. Credentials are held BY REFERENCE — each layer maps
 * to ai-gateway tenant-credential binding ids — and every reference is validated on
 * create and update, so a profile can never be saved pointing at a key the tenant does
 * not have or has revoked.
 */

export interface CredentialRef {
  primary: string;
  secondary?: string;
}

export type CredentialRefs = Partial<Record<VoiceLayer, CredentialRef>>;
export type LayerOverrides = Partial<Record<VoiceLayer, Partial<LayerConfig>>>;
export type LayerFallbacks = Partial<Record<VoiceLayer, LayerConfig>>;

export interface StackProfile {
  profile_id: string;
  tenant_id: string;
  name: string;
  preset_key: PresetKey;
  telephony: LayerConfig;
  stt: LayerConfig;
  llm_fast: LayerConfig;
  llm_complex: LayerConfig;
  tts: LayerConfig;
  credential_refs: CredentialRefs;
  fallbacks: LayerFallbacks;
  certified: boolean;
  status: 'active' | 'archived';
  /** True when every layer the preset requires has a primary credential. */
  complete: boolean;
  created_at: string;
  updated_at: string;
}

export interface CreateStackProfileInput {
  name: string;
  preset_key: string;
  overrides?: LayerOverrides;
  credential_refs?: CredentialRefs;
  fallbacks?: LayerFallbacks;
}

export interface UpdateStackProfileInput {
  name?: string;
  overrides?: LayerOverrides;
  credential_refs?: CredentialRefs;
  fallbacks?: LayerFallbacks;
}

/** One reference that failed validation. */
export interface InvalidCredentialRef {
  layer: VoiceLayer;
  binding_id: string;
}

/**
 * Answers which of `refs` are NOT an active credential binding of `tenantId`.
 * Pluggable so a test (or a future credential store for STT/TTS/telephony) can
 * replace the ai-gateway lookup without touching this service.
 */
export type CredentialChecker = (
  tenantId: string,
  refs: { layer: VoiceLayer; binding_id: string }[],
) => Promise<InvalidCredentialRef[]>;

const defaultCredentialChecker: CredentialChecker = async (tenantId, refs) => {
  if (refs.length === 0) return [];
  const bindings = await listTenantCredentials({ tenant_id: tenantId });
  const active = new Set(bindings.filter((b) => b.status === 'active').map((b) => b.binding_id));
  return refs.filter((r) => !active.has(r.binding_id));
};

let credentialChecker: CredentialChecker = defaultCredentialChecker;

/** Replace the credential checker (tests, alternative credential stores). */
export function setCredentialChecker(checker: CredentialChecker | null): void {
  credentialChecker = checker ?? defaultCredentialChecker;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_NAME_LENGTH = 120;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
/** Postgres unique_violation. */
const PG_UNIQUE_VIOLATION = '23505';

interface StackProfileRow {
  profile_id: string;
  tenant_id: string;
  name: string;
  preset_key: PresetKey;
  telephony: LayerConfig;
  stt: LayerConfig;
  llm_fast: LayerConfig;
  llm_complex: LayerConfig;
  tts: LayerConfig;
  credential_refs: CredentialRefs;
  fallbacks: LayerFallbacks;
  certified: boolean;
  status: 'active' | 'archived';
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `profile_id, tenant_id, name, preset_key, telephony, stt, llm_fast, llm_complex, tts,
                 credential_refs, fallbacks, certified, status, created_at, updated_at`;

function toModel(row: StackProfileRow): StackProfile {
  const preset = findPreset(row.preset_key);
  const required = preset?.required_credential_layers ?? [...VOICE_LAYERS];
  return {
    ...row,
    complete: required.every((layer) => Boolean(row.credential_refs?.[layer]?.primary)),
    created_at: new Date(row.created_at).toISOString(),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function assertLayerKeys(field: string, value: unknown): void {
  if (value === undefined) return;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw validationError(`${field} must be an object keyed by layer`);
  }
  for (const key of Object.keys(value)) {
    if (!isVoiceLayer(key)) throw validationError(`unknown layer in ${field}: ${key}`);
  }
}

function assertCredentialRefs(refs: CredentialRefs | undefined): void {
  assertLayerKeys('credential_refs', refs);
  for (const [layer, ref] of Object.entries(refs ?? {})) {
    if (!ref || typeof ref.primary !== 'string' || !UUID_RE.test(ref.primary)) {
      throw validationError(`credential_refs.${layer}.primary must be a credential binding id (uuid)`);
    }
    if (ref.secondary !== undefined && (typeof ref.secondary !== 'string' || !UUID_RE.test(ref.secondary))) {
      throw validationError(`credential_refs.${layer}.secondary must be a credential binding id (uuid)`);
    }
  }
}

function assertName(name: unknown): string {
  if (typeof name !== 'string' || name.trim().length === 0) throw validationError('name and preset_key are required');
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) throw validationError(`name must be at most ${MAX_NAME_LENGTH} characters`);
  return trimmed;
}

/** Throws CredentialInvalid (422) naming the first reference that is missing or revoked. */
async function assertCredentialsUsable(tenantId: string, refs: CredentialRefs): Promise<void> {
  const flat: { layer: VoiceLayer; binding_id: string }[] = [];
  for (const [layer, ref] of Object.entries(refs) as [VoiceLayer, CredentialRef][]) {
    flat.push({ layer, binding_id: ref.primary });
    if (ref.secondary) flat.push({ layer, binding_id: ref.secondary });
  }
  const invalid = await credentialChecker(tenantId, flat);
  if (invalid.length > 0) {
    const first = invalid[0];
    throw new VoiceAgentError(
      422,
      'CredentialInvalid',
      `credential ${first.binding_id} for layer ${first.layer} is missing or revoked`,
    );
  }
}

/** Preset layers with the overrides merged on top, one layer at a time. */
function mergeLayers(base: LayerMap, overrides: LayerOverrides | undefined): LayerMap {
  const merged = { ...base };
  for (const [layer, override] of Object.entries(overrides ?? {}) as [VoiceLayer, Partial<LayerConfig>][]) {
    merged[layer] = { ...base[layer], ...override } as LayerConfig;
  }
  return merged;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

/**
 * Create a stack profile from a preset.
 *
 * @throws VoiceAgentError 400 on bad input, 409 on a duplicate name, 422 when a
 *   referenced credential is missing or revoked.
 */
export async function createStackProfile(tenantId: string, input: CreateStackProfileInput): Promise<StackProfile> {
  const name = assertName(input.name);
  if (typeof input.preset_key !== 'string' || input.preset_key.length === 0) {
    throw validationError('name and preset_key are required');
  }
  const preset = findPreset(input.preset_key);
  if (!preset) throw validationError(`unknown preset_key: ${input.preset_key}`);
  assertLayerKeys('overrides', input.overrides);
  assertLayerKeys('fallbacks', input.fallbacks);
  assertCredentialRefs(input.credential_refs);

  const credentialRefs = input.credential_refs ?? {};
  await assertCredentialsUsable(tenantId, credentialRefs);
  const layers = mergeLayers(preset.layers, input.overrides);

  try {
    const row = await dataService.one<StackProfileRow>(
      `INSERT INTO voice_agent.stack_profile
         (tenant_id, name, preset_key, telephony, stt, llm_fast, llm_complex, tts, credential_refs, fallbacks)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING ${COLUMNS}`,
      [
        tenantId, name, preset.key,
        JSON.stringify(layers.telephony), JSON.stringify(layers.stt), JSON.stringify(layers.llm_fast),
        JSON.stringify(layers.llm_complex), JSON.stringify(layers.tts),
        JSON.stringify(credentialRefs), JSON.stringify(input.fallbacks ?? {}),
      ],
    );
    if (!row) throw new Error('stack profile insert returned no row');
    return toModel(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('a stack profile with this name already exists');
    throw err;
  }
}

/** List a tenant's stack profiles, newest first. */
export async function listStackProfiles(
  tenantId: string,
  opts: { status?: string; limit?: number; offset?: number } = {},
): Promise<{ stack_profiles: StackProfile[]; limit: number; offset: number }> {
  const status = opts.status ?? 'active';
  if (status !== 'active' && status !== 'archived') throw validationError('status must be active or archived');
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? DEFAULT_PAGE_SIZE), 1), MAX_PAGE_SIZE);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const rows = await dataService.rows<StackProfileRow>(
    `SELECT ${COLUMNS} FROM voice_agent.stack_profile
      WHERE tenant_id = $1 AND status = $2
      ORDER BY created_at DESC
      LIMIT $3 OFFSET $4`,
    [tenantId, status, limit, offset],
  );
  return { stack_profiles: rows.map(toModel), limit, offset };
}

/** One of the tenant's stack profiles, or null (another tenant's profile is also null). */
export async function getStackProfile(tenantId: string, profileId: string): Promise<StackProfile | null> {
  if (!UUID_RE.test(profileId)) return null;
  const row = await dataService.one<StackProfileRow>(
    `SELECT ${COLUMNS} FROM voice_agent.stack_profile WHERE tenant_id = $1 AND profile_id = $2`,
    [tenantId, profileId],
  );
  return row ? toModel(row) : null;
}

/**
 * Update an active stack profile. Overrides merge onto the CURRENT layers; credential_refs
 * and fallbacks replace wholesale. All resulting credential refs are re-validated.
 *
 * @throws VoiceAgentError 400 / 404 / 409 (archived or duplicate name) / 422.
 */
export async function updateStackProfile(
  tenantId: string,
  profileId: string,
  input: UpdateStackProfileInput & { preset_key?: unknown },
): Promise<StackProfile> {
  if (input.preset_key !== undefined) throw validationError('preset_key cannot be changed; create a new profile');
  const current = await getStackProfile(tenantId, profileId);
  if (!current) throw notFound('stack profile not found');
  if (current.status === 'archived') throw conflict('archived stack profiles cannot be edited');

  const name = input.name === undefined ? current.name : assertName(input.name);
  assertLayerKeys('overrides', input.overrides);
  assertLayerKeys('fallbacks', input.fallbacks);
  assertCredentialRefs(input.credential_refs);

  const credentialRefs = input.credential_refs ?? current.credential_refs;
  await assertCredentialsUsable(tenantId, credentialRefs);
  const layers = mergeLayers(
    { telephony: current.telephony, stt: current.stt, llm_fast: current.llm_fast, llm_complex: current.llm_complex, tts: current.tts },
    input.overrides,
  );

  try {
    const row = await dataService.one<StackProfileRow>(
      `UPDATE voice_agent.stack_profile
          SET name = $3, telephony = $4, stt = $5, llm_fast = $6, llm_complex = $7, tts = $8,
              credential_refs = $9, fallbacks = $10, updated_at = now()
        WHERE tenant_id = $1 AND profile_id = $2 AND status = 'active'
        RETURNING ${COLUMNS}`,
      [
        tenantId, profileId, name,
        JSON.stringify(layers.telephony), JSON.stringify(layers.stt), JSON.stringify(layers.llm_fast),
        JSON.stringify(layers.llm_complex), JSON.stringify(layers.tts),
        JSON.stringify(credentialRefs), JSON.stringify(input.fallbacks ?? current.fallbacks),
      ],
    );
    // Archived between the read and the write.
    if (!row) throw conflict('archived stack profiles cannot be edited');
    return toModel(row);
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('a stack profile with this name already exists');
    throw err;
  }
}

/** Archive (soft-delete) a profile. False when the tenant has no such profile; idempotent otherwise. */
export async function archiveStackProfile(tenantId: string, profileId: string): Promise<boolean> {
  if (!UUID_RE.test(profileId)) return false;
  const result = await dataService.query(
    `UPDATE voice_agent.stack_profile
        SET status = 'archived', updated_at = now()
      WHERE tenant_id = $1 AND profile_id = $2`,
    [tenantId, profileId],
  );
  return (result.rowCount ?? 0) > 0;
}
