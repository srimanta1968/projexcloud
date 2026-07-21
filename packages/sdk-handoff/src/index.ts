/**
 * @projexlight/sdk-handoff — Sales→Delivery handoff with accept/reject (P15·E2).
 *
 * Handoff CRUD + status lifecycle (draft -> pending -> accepted/rejected ->
 * completed, cancellable from any non-terminal state). Every transition is
 * validated and emits a lifecycle event through sdk-audit. The sdk-workflow
 * saga and sdk-approval accept/reject gate integrate by loose id.
 */
export { migrationsDir } from './db';

export {
  createHandoff,
  getHandoff,
  listHandoffs,
  updateHandoff,
  transitionHandoff,
  InvalidHandoffTransition,
} from './services/handoffService';

// Durable saga (driven by sdk-workflow) — registered + started by the gateway.
export {
  registerHandoffSaga,
  startHandoffSaga,
  listHandoffSagaSteps,
  SAGA_PHASES,
} from './services/handoffSaga';

// CS accept/reject gate — delegated to sdk-approval via the pluggable creator.
export {
  requestHandoffApproval,
  recordHandoffDecision,
  setHandoffApprovalCreator,
} from './services/handoffApproval';
export type { HandoffApprovalCreator, HandoffApprovalContext, HandoffDecision } from './services/handoffApproval';

export {
  HANDOFF_TRANSITIONS,
  HANDOFF_TRANSITION_EVENT,
  isValidTransition,
} from './models/handoff.model';
export type {
  HandoffStatus,
  HandoffRecord,
  CreateHandoffInput,
  UpdateHandoffInput,
} from './models/handoff.model';

// HTTP surface (P15·E2) — mounted by the api-gateway.
export * as server from './server';
