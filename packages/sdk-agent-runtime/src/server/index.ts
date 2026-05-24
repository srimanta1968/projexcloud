/**
 * Server-side surface for sdk-agent-runtime. The hosting service
 * (services/api-gateway for prototype; eventually services/agent-runtime-service)
 * imports `registerRoutes` and mounts it on its Fastify instance.
 */
export { registerRoutes } from './routes';
