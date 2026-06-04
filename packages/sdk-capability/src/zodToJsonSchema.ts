/**
 * Minimal Zod → JSON Schema converter (P9.2 / Epic B, TK-3464).
 *
 * The build step that emits endpoint request_schema/response_schema into
 * sdk-capability.json calls this on each SDK's existing Zod request/response
 * schemas. Kept dependency-free (introspects Zod's internal `_def` at runtime)
 * so sdk-capability needn't take a hard zod dependency; covers the constructs
 * SDK DTOs actually use (object/string/number/boolean/array/enum/optional/
 * nullable/default). Unknown nodes degrade to `{}` (any) rather than throwing,
 * so a schema is always producible.
 */

interface ZodDefLike {
  typeName?: string;
  innerType?: ZodLike;
  type?: ZodLike;
  shape?: () => Record<string, ZodLike>;
  values?: unknown[];
  checks?: Array<{ kind?: string }>;
}
interface ZodLike {
  _def?: ZodDefLike;
}

export type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: ZodLike): JsonSchema {
  const def = schema?._def;
  if (!def || !def.typeName) return {};

  switch (def.typeName) {
    case 'ZodObject': {
      const shape = def.shape ? def.shape() : {};
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(child);
        if (!isOptional(child)) required.push(key);
      }
      const out: JsonSchema = { type: 'object', properties };
      if (required.length) out.required = required;
      return out;
    }
    case 'ZodString': {
      const out: JsonSchema = { type: 'string' };
      const fmt = (def.checks ?? []).find((c) => c.kind === 'email' || c.kind === 'uuid' || c.kind === 'url');
      if (fmt?.kind) out.format = fmt.kind;
      return out;
    }
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodDate':
      return { type: 'string', format: 'date-time' };
    case 'ZodArray':
      return { type: 'array', items: def.type ? zodToJsonSchema(def.type) : {} };
    case 'ZodEnum':
      return { type: 'string', enum: def.values ?? [] };
    case 'ZodNativeEnum':
      return { enum: Object.values(def.values ?? {}) };
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return def.innerType ? zodToJsonSchema(def.innerType) : {};
    case 'ZodEffects':
      return def.innerType ? zodToJsonSchema(def.innerType) : {};
    default:
      return {};
  }
}

function isOptional(child: ZodLike): boolean {
  const tn = child?._def?.typeName;
  return tn === 'ZodOptional' || tn === 'ZodDefault' || tn === 'ZodNullable';
}
