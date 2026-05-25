export interface RegisterInput {
  email: string;
  password: string;
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

/**
 * Validates the signup payload. Email must look like an email; password must
 * be >= 8 chars.
 */
export function validateRegisterInput(body: unknown): ValidationSuccess<RegisterInput> | ValidationFailure {
  const errors: string[] = [];
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['body must be an object'] };
  }
  const b = body as Record<string, unknown>;
  const email = typeof b.email === 'string' ? b.email.trim() : '';
  const password = typeof b.password === 'string' ? b.password : '';

  if (!email) errors.push('email is required');
  else if (!EMAIL_RE.test(email)) errors.push('email is invalid');

  if (!password) errors.push('password is required');
  else if (password.length < 8) errors.push('password must be at least 8 characters');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { email, password } };
}

export interface SignupTenantInput {
  email: string;
  password: string;
  company_name: string;
  region?: string;
}

/**
 * Validates the self-serve signup payload (person + org + tenant in one shot).
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

  if (!email) errors.push('email is required');
  else if (!EMAIL_RE.test(email)) errors.push('email is invalid');

  if (!password) errors.push('password is required');
  else if (password.length < 8) errors.push('password must be at least 8 characters');

  if (!company_name) errors.push('company_name is required');
  else if (company_name.length > 80) errors.push('company_name must be 80 characters or fewer');

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { email, password, company_name, region } };
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
