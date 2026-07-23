import { apiGet, apiPost, setToken } from '../lib/apiClient';

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface RegisterResponse {
  userId: string;
  email: string;
  token?: string;
}

/**
 * POST /api/auth/register — creates a new user. The API returns a session token
 * (unchanged contract), but the verification-first UX deliberately does NOT
 * auto-login: it triggers a verification email and routes the user to the
 * "check your email" screen. They verify, then sign in via /login (which checks
 * verification status first).
 */
export async function registerUser(input: RegisterRequest): Promise<RegisterResponse> {
  const data = await apiPost<RegisterResponse>('/api/auth/register', input);
  await sendVerificationEmail(data.userId, data.email).catch(() => undefined);
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
  token?: string;
}

/**
 * POST /api/auth/signup-tenant — full self-serve signup: creates the person,
 * a new org + default app, a trial tenant, and an admin membership. Returns a
 * tenant-scoped token (unchanged contract), but like registerUser the
 * verification-first UX triggers a verification email and does not auto-login.
 */
export async function signupTenant(input: SignupTenantRequest): Promise<SignupTenantResponse> {
  const data = await apiPost<SignupTenantResponse>('/api/auth/signup-tenant', input);
  await sendVerificationEmail(data.userId, data.email).catch(() => undefined);
  return data;
}

export interface VerifyEmailResponse {
  verified: boolean;
  email: string;
}

/** POST /api/auth/verify-email — confirms the email-verification token (link click). */
export async function verifyEmail(token: string): Promise<VerifyEmailResponse> {
  return apiPost<VerifyEmailResponse>('/api/auth/verify-email', { token });
}

/**
 * POST /api/auth/send-verification-email — separate, additive endpoint. Requests
 * a verification email for the given user. Used after signup and by "Resend".
 */
export async function sendVerificationEmail(userId: string | undefined, email: string): Promise<void> {
  await apiPost<{ sent: boolean; email: string }>('/api/auth/send-verification-email', { userId, email });
}

export interface VerificationStatus {
  exists: boolean;
  verified: boolean;
}

/**
 * GET /api/auth/verification-status — separate, additive read. The login page
 * calls this BEFORE /api/auth/login to enforce verification client-side.
 */
export async function getVerificationStatus(email: string): Promise<VerificationStatus> {
  return apiGet<VerificationStatus>(`/api/auth/verification-status?email=${encodeURIComponent(email)}`);
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
