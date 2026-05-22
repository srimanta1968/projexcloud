import path from 'path';

/**
 * Absolute path to this SDK's migrations folder. The platform migration runner
 * discovers SDKs by importing `migrationsDir` from each `@projexlight/sdk-*`
 * package. Per ProjectStructure-v3.1 §6.3.
 */
export const migrationsDir: string = path.join(__dirname, 'migrations');
