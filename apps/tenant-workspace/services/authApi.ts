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
