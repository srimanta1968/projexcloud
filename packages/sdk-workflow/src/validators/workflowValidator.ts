import type {
  RegisterDefinitionInput,
  SignalInput,
  StartRunInput,
  StepSpec,
} from '../models/workflow.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

function asString(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

function isStepSpec(v: unknown): v is StepSpec {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return typeof s.name === 'string' && s.name.length > 0
    && (s.compensate === undefined || typeof s.compensate === 'string');
}

export function validateRegisterDefinition(body: unknown): ValidationResult<RegisterDefinitionInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const name = asString(b.name);
  const step_specs = Array.isArray(b.step_specs) ? b.step_specs : null;

  if (!name) errors.push('name is required');
  if (!step_specs || step_specs.length === 0) errors.push('step_specs must be a non-empty array');
  else if (!step_specs.every(isStepSpec)) errors.push('each step_specs entry needs {name: string, compensate?: string}');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      step_specs: step_specs as StepSpec[],
      version: typeof b.version === 'string' ? b.version : undefined,
      namespace: typeof b.namespace === 'string' ? b.namespace : undefined,
    },
  };
}

export function validateStartRun(body: unknown): ValidationResult<StartRunInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const name = asString(b.name);
  if (!name) errors.push('name is required');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      name,
      version: typeof b.version === 'string' ? b.version : undefined,
      namespace: typeof b.namespace === 'string' ? b.namespace : undefined,
      envelope: (b.envelope && typeof b.envelope === 'object')
        ? (b.envelope as StartRunInput['envelope']) : undefined,
      input: (b.input && typeof b.input === 'object')
        ? (b.input as Record<string, unknown>) : undefined,
    },
  };
}

export function validateSignal(body: unknown): ValidationResult<SignalInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const signal_name = asString(b.signal_name);
  if (!signal_name) errors.push('signal_name is required');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      signal_name,
      payload: (b.payload && typeof b.payload === 'object')
        ? (b.payload as Record<string, unknown>) : undefined,
    },
  };
}
