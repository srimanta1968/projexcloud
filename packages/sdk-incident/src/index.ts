/**
 * @projexlight/sdk-incident — exception/incident record & evidence (P15·E3).
 *
 * Incident CRUD + status lifecycle (open -> investigating -> mitigated ->
 * resolved -> closed, cancellable while pre-resolved) + tenant-scoped SLA-breach
 * scan. Every transition is validated and emits a lifecycle event via sdk-audit.
 */
export { migrationsDir } from './db';

export {
  createIncident,
  getIncident,
  listIncidents,
  updateIncident,
  transitionIncident,
  findSlaBreaches,
  notifySlaBreach,
  InvalidIncidentTransition,
} from './services/incidentService';

export {
  INCIDENT_TRANSITIONS,
  isValidTransition,
} from './models/incident.model';
export type {
  IncidentStatus,
  IncidentSeverity,
  IncidentRecord,
  CreateIncidentInput,
  UpdateIncidentInput,
} from './models/incident.model';

// HTTP surface (P15·E3) — mounted by the api-gateway.
export * as server from './server';
