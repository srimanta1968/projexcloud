/**
 * @projexlight/sdk-semantic — public surface.
 *
 * P6B · Closes Gate G9. The Enterprise Semantic Model Layer with the six
 * typed primitives: SemanticObject · SemanticRelation · CapabilityGraph
 * · DomainOntology · SemanticIntent · SemanticPolicy.
 *
 * Three executors land in this drop:
 *   - registerOntology: atomically loads an ontology bundle into all 4
 *                       backing tables
 *   - plan: walks Intent → CapabilityGraph → Plan (no LLM in v1)
 *   - evaluate: ontology-aware authz, IQL-compiled to ABAC + ReBAC
 */
export { migrationsDir } from './db';

// Ontology registry (Type 4).
export {
  registerOntology,
  getActiveOntology,
  listOntologies,
  deprecateOntology,
} from './services/ontologyService';
export type {
  RegisterOntologyInput,
  RegisterOntologyResult,
} from './services/ontologyService';

// Intent → Plan (Type 5).
export {
  plan,
  getPlan,
  updatePlanStatus,
} from './services/planService';

// SemanticPolicy compile + evaluate (Type 6).
export {
  compileIql,
  registerPolicy,
  evaluate,
  listPolicies,
} from './services/policyService';
export type {
  RegisterPolicyInput,
  CompiledPolicy,
  EvaluateContext,
} from './services/policyService';

// Cross-domain bridges (Patient ↔ Person, …).
export {
  createBridge,
  listBridges,
} from './services/bridgeService';
export type { CreateBridgeInput } from './services/bridgeService';

// MCP → CapabilityGraph wiring (FR-SEM-9).
export {
  registerMcpCapability,
  deprecateMcpCapabilities,
} from './services/mcpCapabilityService';
export type {
  RegisterMcpCapabilityInput,
  RegisterMcpCapabilityResult,
} from './services/mcpCapabilityService';
