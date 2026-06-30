export interface RegisterInput {
  email: string;
  password: string;
  /** Optional human-identity fields. Persisted into the L2 profile band by the service layer. */
  given_name?: string;
  family_name?: string;
  display_name?: string;
  phone?: string;
}

export interface LoginInput {
  email: string;
  password: string;
  tenant_id?: string;
  app_id?: string;
}

export interface ValidationFailure {
  ok: false;
  errors: string[];
}

export interface ValidationSuccess<T> {
  ok: true;
  value: T;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// E.164-ish: optional leading +, then 7-20 digits/spacing chars. Permissive on
// formatting, strict enough to reject obvious non-phone input.
const PHONE_RE = /^\+?[0-9][0-9\s\-().]{6,19}$/;

/** Reads an optional, trimmed, length-bounded string field; '' or non-string → undefined. */
function optionalName(value: unknown): string | undefined {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > 0 ? s : undefined;
}

/**
 * Validates the signup payload. Email must look like an email; password must
 * be >= 8 chars. given_name/family_name/display_name are optional human-identity
 * fields; phone is optional and format-validated when present.
 */
export function validateRegisterInput(body: unknown): ValidationSuccess<RegisterInput> | ValidationFailure {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['body must be an object'] };
  }
  const b = body as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const given_name = optionalName(b.given_name);
  const family_name = optionalName(b.family_name);
  const display_name = optionalName(b.display_name);
  const phone = optionalName(b.phone);

  if (!email) errors.push('email is required');
  else if (!EMAIL_RE.test(email)) errors.push('email is invalid');

  if (!password) errors.push('password is required');
  else if (password.length < 8) errors.push('password must be at least 8 characters');

  for (const [field, val] of [['given_name', given_name], ['family_name', family_name], ['display_name', display_name]] as const) {
    if (val && val.length > 120) errors.push(`${field} must be 120 characters or fewer`);
  }
  if (phone && !PHONE_RE.test(phone)) errors.push('phone is invalid');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { email, password, given_name, family_name, display_name, phone } };
}

export interface SignupTenantInput {
  email: string;
  password: string;
  company_name: string;
  region?: string;
  /** Optional human-identity fields for the founding member's profile band. */
  given_name?: string;
  family_name?: string;
  display_name?: string;
  phone?: string;
}

/**
 * Validates the self-serve signup payload (person + org + tenant in one shot).
 * Person-identity fields (given_name/family_name/display_name/phone) are optional;
 * phone is format-validated when present.
 */
export function validateSignupTenantInput(body: unknown): ValidationSuccess<SignupTenantInput> | ValidationFailure {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['body must be an object'] };
  }
  const b = body as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const company_name = typeof b.company_name === 'string' ? b.company_name.trim() : '';
  const region = typeof b.region === 'string' ? b.region.trim() : undefined;
  const given_name = optionalName(b.given_name);
  const family_name = optionalName(b.family_name);
  const display_name = optionalName(b.display_name);
  const phone = optionalName(b.phone);

  if (!email) errors.push('email is required');
  else if (!EMAIL_RE.test(email)) errors.push('email is invalid');

  if (!password) errors.push('password is required');
  else if (password.length < 8) errors.push('password must be at least 8 characters');

  if (!company_name) errors.push('company_name is required');
  else if (company_name.length > 80) errors.push('company_name must be 80 characters or fewer');

  for (const [field, val] of [['given_name', given_name], ['family_name', family_name], ['display_name', display_name]] as const) {
    if (val && val.length > 120) errors.push(`${field} must be 120 characters or fewer`);
  }
  if (phone && !PHONE_RE.test(phone)) errors.push('phone is invalid');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { email, password, company_name, region, given_name, family_name, display_name, phone } };
}

/**
 * Validates the login payload. tenant_id is optional - if present, the JWT
 * is minted with that tenant context after verifying the person has an
 * active membership.
 */
export function validateLoginInput(body: unknown): ValidationSuccess<LoginInput> | ValidationFailure {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['body must be an object'] };
  }
  const b = body as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const tenant_id = typeof b.tenant_id === 'string' ? b.tenant_id.trim() : undefined;
  const app_id = typeof b.app_id === 'string' ? b.app_id.trim() : undefined;

  if (!email) errors.push('email is required');
  if (!password) errors.push('password is required');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { email, password, tenant_id, app_id } };
}
