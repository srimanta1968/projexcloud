/**
 * Server-side surface for sdk-vault. The hosting service (services/api-gateway
 * for prototype; eventually services/vault-service) imports `registerRoutes`
 * and mounts it on its Fastify instance.
 */
export { registerRoutes } from './routes';
