import { apiPost, setToken } from '../lib/apiClient';

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface RegisterResponse {
  userId: string;
  email: string;
  token: string;
}

/**
 * POST /api/auth/register — creates a new user and persists the returned JWT
 * for subsequent authenticated calls.
 */
export async function registerUser(input: RegisterRequest): Promise<RegisterResponse> {
  const data = await apiPost<RegisterResponse>('/api/auth/register', input);
  setToken(data.token);
  return data;
}

export interface SignupTenantRequest {
  email: string;
  password: string;
  company_name: string;
  region?: string;
}

export interface SignupTenantResponse {
  userId: string;
  email: string;
  tenant_id: string;
  app_id: string;
  org_id: string;
  display_name: string;
  region: string;
  token: string;
}

/**
 * POST /api/auth/signup-tenant — full self-serve signup: creates the person,
 * a new org + default app, a trial tenant, and an admin membership. Returns
 * a JWT already scoped to the new tenant.
 */
export async function signupTenant(input: SignupTenantRequest): Promise<SignupTenantResponse> {
  const data = await apiPost<SignupTenantResponse>('/api/auth/signup-tenant', input);
  setToken(data.token);
  return data;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  userId: string;
  email: string;
  tenant_id: string | null;
  app_id: string | null;
  org_id: string | null;
  token: string;
}

/**
 * POST /api/auth/login — verifies email + password, mints a six-layer JWT
 * scoped to the user's active tenant/app/org, persists it for subsequent
 * authenticated calls.
 */
export async function loginUser(input: LoginRequest): Promise<LoginResponse> {
  const data = await apiPost<LoginResponse>('/api/auth/login', input);
  setToken(data.token);
  return data;
}

/**
 * Local-only logout: clears the persisted token. The JWT itself remains
 * cryptographically valid until expiry; for hard revoke the operator
 * should rotate the JWT secret or block via sdk-identity's session
 * deny-list (server-side concern).
 */
export function logoutUser(): void {
  setToken(null);
}
