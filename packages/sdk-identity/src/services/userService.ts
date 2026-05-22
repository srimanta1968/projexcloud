import bcrypt from 'bcryptjs';
import { dataService } from '@projexlight/db-runtime';

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

export interface UserRecord {
  id: string;
  email: string;
  created_at: Date;
  updated_at: Date;
}

export class UserExistsError extends Error {
  constructor(email: string) {
    super(`User already exists: ${email}`);
    this.name = 'UserExistsError';
  }
}

/**
 * Creates a new user with a bcrypt-hashed password. Throws UserExistsError if
 * the email is already taken (case-insensitive).
 */
export async function createUser(email: string, password: string): Promise<UserRecord> {
  const normalized = email.trim().toLowerCase();
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

  try {
    const rows = await dataService.rows<UserRecord>(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       RETURNING id, email, created_at, updated_at`,
      [normalized, passwordHash],
    );
    return rows[0];
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === '23505') {
      throw new UserExistsError(normalized);
    }
    throw err;
  }
}

/**
 * Fetches a user by email (case-insensitive). Returns null when not found.
 */
export async function findUserByEmail(email: string): Promise<UserRecord | null> {
  return dataService.one<UserRecord>(
    `SELECT id, email, created_at, updated_at FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
}
