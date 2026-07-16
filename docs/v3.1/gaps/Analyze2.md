1. What the meeting appears to propose
   The emerging architecture is roughly this:
   Infrastructure Layer - VMs / droplets / Kubernetes / container registry / GitOps / VPN - Keycloak for infrastructure access - SPIFFE/SPIRE or similar for service identity - mTLS for internal service communicationPlatform Layer - Identity / MDM - Consent management - ABAC / OPA - Observability portal / telemetry / Grafana - Event backbone: Kafka / Redpanda - Internal communication: NATS / JetStream, probably - Secure service routing / service mesh / sidecar - Shell / OSL / container contract for appsApplication Layer - React / Next.js frontend - FastAPI / Node / possibly Go services - Supabase for external customer-facing authentication/session convenience - App-specific services and databases
   The meeting also frames the shell as a Google-like container: applications run inside it, and the shell knows who the user is, what app they are in, their roles, permissions, scope, plan tier, app/container context, identity context, ABAC context, lineage context, observability context, and security context.
   This is directionally right. But the current version needs hard architectural correction before implementation.

2. Core criticism: the design is mixing five different “identities”
   The biggest risk is that the word identity is being used for multiple different things.
   These are not the same:
   Identity TypeMeaningExampleOwnerHuman login identityWho is authenticated in a session?Justin logged in via GoogleSupabase / Keycloak / IdPInfrastructure operator identityWho can access infra?Prashant can access VPN/K8sKeycloak / VPN / IAMService identityWhich service is calling?mdm-resolver calling policy-gatewaySPIFFE/SPIRE + mTLSPlatform subject identityWho/what is requesting an action?User, service, tenant, app, device, orgPlatform context serviceMaster data identityWhat real-world entity is this?Ankush as patient/person across systemsMDM
   The meeting correctly says MDM is “data identity, not user identity,” using the patient/radiologist/doctor example. That is the strongest conceptual point in the meeting.
   But if the team does not write this distinction into the architecture, Supabase, Keycloak, OPA, MDM, and app databases will all slowly start carrying overlapping identity truth. That will become unmanageable.
   Hard rule:
   Supabase and Keycloak authenticate sessions.
   SPIFFE/mTLS authenticates services.
   OPA authorizes actions.
   Consent authorizes purpose-bound data use.
   MDM resolves real-world entities.
   None of these should pretend to be the others.

3. Major negatives and failure modes
   3.1 “Platform layer” is too broad right now
   The meeting puts identity, consent, ABAC, observability, security communication, event backbone, data pipelines, MLOps, service mesh, and shell into the platform layer. That may be true organizationally, but it is too broad architecturally.
   If “platform” means everything above infra and below apps, then the platform becomes a swamp.
   You need narrower sub-planes:
   Platform Layer 1. Trust Plane 2. Session Plane 3. Policy Plane 4. Consent Plane 5. MDM / Identity Graph Plane 6. Event & Workflow Plane 7. Observability / Audit / Lineage Plane 8. Developer Experience / Shell Plane
   Without this decomposition, every design discussion will keep looping back into “Is this infra? Is this platform? Is this MDM? Is this auth?”
   That confusion already appears repeatedly in the meeting, especially around Supabase vs Keycloak, authentication vs authorization, and whether platform apps should directly access internal services.

3.2 Supabase + Keycloak + OPA + mTLS can become a four-headed auth monster
The meeting spends a lot of time debating whether Keycloak alone is enough, or whether Supabase + OPA + Keycloak is justified. The stated split is:
Keycloak = infra/internal accessSupabase = external/customer-facing auth and app sessionsOPA = fine-grained authorizationmTLS/SPIFFE = service-to-service identity
This can work, but only if the boundaries are extremely strict.
The danger is:
Supabase has rolesKeycloak has rolesOPA has policiesPostgres RLS has policiesApp code has if-statementsUI has hidden fields
That creates policy drift.
A user may be allowed by Supabase RLS, denied by OPA, allowed by app code, hidden by UI, and logged inconsistently by observability. That is worse than having no platform.
Required correction: Create one canonical authorization flow:
Authenticate user/session → normalize into Platform Principal → enrich with app_id, tenant_id, org_id, bu_id, device, purpose, consent → call OPA shell → receive decision + obligations → enforce at gateway/service/data layer → audit decision
Supabase and Keycloak should not be treated as final authorization authorities for business data. They are upstream identity/session providers. OPA is the decision engine. Data services enforce. UI only reflects decisions; it must never be the only enforcement layer.

3.3 Authentication vs authorization is still confused
The meeting explicitly discusses confusion around authentication and authorization. That confusion is not cosmetic; it is a system risk.
Authentication answers:
Who are you?
Authorization answers:
What are you allowed to do, on which resource, for what purpose, in which context?
MDM answers:
Which real-world entity does this record refer to?
Consent answers:
Has this subject permitted this processing purpose?
ABAC answers:
Do these attributes satisfy the policy?
The platform must enforce these as separate stages. Do not let “role” become a garbage bucket for everything.
Bad pattern:
{ "role": "super_admin"}
Better pattern:
{ "principal": { "user_id": "u_123", "auth_provider": "supabase", "assurance_level": "mfa", "org_memberships": [...] }, "resource": { "type": "financial_report", "tenant_id": "t_456", "classification": "restricted" }, "action": "read", "context": { "purpose": "audit", "device_trust": "managed", "network_zone": "corp_vpn", "time": "2026-06-12T..." }}

3.4 The shell concept is powerful but dangerously vague
The “shell” is currently described as:

a container for all applications,

a context provider,

an app integration layer,

a sidecar,

an OS-like node,

something apps call instead of platform directly,

something that understands identity, ABAC, lineage, observability, security and permissions.

That can become a god component.
There are four different possible interpretations:
InterpretationWhat it isRiskFrontend shellReact/Next app containerBecomes UI-only, cannot enforce backend policyBackend gatewayAPI gateway/BFFBecomes bottleneckSidecarEnvoy/service sidecarToo low-level for business contextPlatform SDKGenerated client librariesEasier for developers but weaker central control
You probably need all four, but with separate names.
Recommended split:

1. App Shell UI container, layout, navigation, session context, visible capabilities.2. Platform Gateway North-south API entry point. Validates tokens, calls OPA, enforces coarse policy.3. Service Sidecar / Mesh Proxy East-west service identity, mTLS, retries, telemetry, traffic policy.4. Platform SDK Generated clients for Go/TypeScript/Python so app developers do not hand-roll auth, audit, MDM calls.
   Do not call all of them “shell.” It will confuse the team.

3.5 “Apps should not talk directly to platform” needs refinement
The meeting says apps should not directly talk to the platform; they should go through an intermediary container/shell.
This is right in spirit but wrong if interpreted rigidly.
Some platform capabilities should be called through the gateway:
external app → platform gateway → MDM / policy / consent
Some should be called by backend services through service mesh:
service → sidecar/mTLS → platform service
Some should be consumed asynchronously:
app event → event backbone → platform processors
Some should be embedded as SDK helpers:
app code → generated SDK → platform APIs
If every platform call must go through one intermediary, that intermediary becomes a choke point and versioning nightmare.
Better rule:

Apps must not bypass platform contracts. They may call platform contracts through approved channels: gateway, SDK, sidecar, or events.

3.6 Event backbone choices are not yet rationalized
The notes mention Kafka, Redpanda, NATS, and JetStream. Redpanda is suggested for heavier injection/pipeline scenarios, Kafka for others, and NATS/JetStream for internal communication between CM/MDM-like services.
This is plausible, but currently under-specified.
You need a clean event taxonomy:
Use CaseRecommended BackboneImmutable business/reality eventsKafka or RedpandaHigh-throughput ingestion pipelinesRedpanda/KafkaInternal command/controlNATSLightweight durable work queuesJetStreamLong-running business workflowsTemporalRequest/response service callsgRPCBrowser events/UIHTTP/SSE/WebSocket
Do not use both Kafka and Redpanda casually. Pick one primary “Reality Log” platform unless you have a specific reason to run both. Running both doubles operational burden.
Potential clean rule:
Kafka/Redpanda = durable event historyNATS/JetStream = internal platform command busTemporal = durable workflow stategRPC = synchronous service contract

3.7 OPA is being treated as magic ABAC
OPA can answer policy decisions, but it does not automatically solve:

policy data modeling,

policy lifecycle,

policy versioning,

admin UI,

explainability,

field masking obligations,

row filtering,

data joins,

low-latency distribution,

cache invalidation,

audit trails,

testing and simulation.

The meeting says OPA can decide which screen, API, row or attribute a user can access. That is only true if the entire data model and enforcement model are designed around it.
OPA typically returns a decision. You must define whether it returns:
{ "allow": true}
or richer obligations:
{ "allow": true, "obligations": { "mask": ["profit_margin", "ssn"], "filter": { "tenant_id": "t_123", "region": ["US", "EU"] }, "audit": true, "ttl_seconds": 900 }}
Without obligations, OPA will only answer yes/no, and every app team will invent its own masking/filtering logic.

3.8 Consent and authorization are at risk of being conflated
The meeting states that consent must be taken early and that the consent management platform may sit outside the perimeter, with internal systems checking consent for purposes like marketing, tracking, and audit behavior.
Correct. But consent is not the same as authorization.
A user may have permission to access a record but no consent to use it for a particular purpose.
Example:
Doctor can access patient record for treatment.Doctor cannot access same record for marketing.Research analyst can access de-identified data for approved study.Marketing app cannot access PHI even if user is a platform admin.
The architecture should separate:
OPA = Can this actor perform this action on this resource?CMP = Is this processing purpose permitted by subject consent/lawful basis?MDM = Which subject/resource/entity is this actually about?SAS/Vault = Can sensitive data be revealed under the approved context?
Consent should be an input into OPA decisions, not a replacement for OPA.

3.9 Supabase RLS plus OPA can create two sources of truth
Supabase RLS is powerful for simple row-level access. But if the real platform policy lives in OPA, and Supabase has its own RLS policies, you may create two independent policy systems.
This is acceptable only if you define clear use cases:
Supabase RLS: - lightweight external app data - non-core data - edge/session-bound row filtering - simple tenant isolationOPA: - cross-app policy - platform-level ABAC - sensitive data access - field-level obligations - MDM/consent-aware decisions - audit-grade decisions
If a resource is sensitive, canonical, MDM-linked, PHI/PII/financial, or multi-tenant enterprise data, OPA should be authoritative. Supabase RLS may be a defense-in-depth filter, not the policy source of truth.

3.10 Service-to-service routing via sidecar is underdefined
The meeting says requests go through a service mesh, with a sidecar such as Envoy forwarding necessary information to the target service, and the target service then performs authorization.
This is plausible. But you need to prevent the confused deputy problem.
Bad:
User sends JWTGateway forwards JWT headersService trusts headers
Better:
Gateway validates external JWTGateway mints internal Platform Principal TokenToken is audience-bound to target serviceService verifies token + mTLS identityService calls OPA or checks signed policy decisionService emits audit event
Never trust raw forwarded headers unless they are cryptographically protected or injected only by trusted mesh infrastructure.

3.11 Observability is mentioned but not designed
The meeting expects observability portal, telemetry checks, Grafana, alerts, network perimeter visibility, mobile/web/direct access tracing, and data engineering pipeline visibility.
Good instinct. But current design needs explicit observability types:
Observability TypeRequired EventsInfrastructure observabilityCPU, memory, network, pods, nodesService observabilitytraces, latency, error ratesSecurity observabilityauth failures, privilege changes, suspicious accessData observabilitypipeline freshness, volume, schema driftMDM observabilitymatch confidence, unresolved identities, merge reversalsPolicy observabilityOPA allow/deny, policy version, obligationsConsent observabilityconsent checked, purpose, receipt IDAudit observabilitywho accessed what, when, why, from where
If all these go into one Grafana dashboard without taxonomy, nobody will know what matters.

3.12 Resource ownership problem is real and must be solved before scale
The notes contain a practical concern: droplets, container registry, and resources are being created, but ownership is unclear; the desire is to manage everything through GitOps.
This is a serious platform maturity issue.
No platform should proceed without:
resource_idcloud_providerenvironmentownerbusiness_purposerepo_sourceterraform_modulecost_centercreated_byapproved_bydata_classificationexpiry_policy
Every VM, cluster, DB, bucket, registry, queue, topic and service must have an owner. Otherwise, platform security is impossible.

3.13 Go for core services is directionally right, but not enough
The meeting says MDM should be written in Go because FastAPI/Node may “burst” under billion-scale workloads and because identity resolution may involve massive data volumes.
Go is a good choice for:

core MDM APIs,

identity resolution gateway,

event consumers,

OPA sidecar integrations,

high-throughput tokenization clients,

gRPC services,

service mesh-aware daemons.

But Go alone does not solve scale.
You still need:
partitioning modelevent key strategytenant isolationcaching strategydatabase selectionbackpressure modelbatch vs real-time modeidempotencyexactly-once or effectively-once semanticsschema versioningreplay strategy
A badly designed Go service will fail faster than a well-designed Python service.

3.14 The billion-scale statement is currently not supported by architecture
The meeting mentions billions of users/patients/records and three million identities being resolved.
That ambition is valid. But there is not yet a concrete scale design.
To support billions, you need to answer:
How are canonical IDs partitioned?How are identity handles hashed?How is PII tokenized before indexing?What is the matching window?Do we support global entity resolution or tenant-scoped first?What is the SLA for deterministic match?What is the SLA for probabilistic match?What is the maximum graph traversal depth in real time?Where does AI run: online, async, batch, or steward queue?How are false merges reversed?How is cross-region data residency handled?
Without these answers, “billions” remains aspirational.

4. Stress test scenarios
   Below are the stress tests I would run mentally before accepting the design.
   Scenario 1: Supabase is down
   Question:
   Can external users still access app sessions?Can internal platform operators still access infrastructure?Can machine-to-machine services continue?
   Expected answer:
   External login may degrade.Existing short-lived sessions may continue until expiry if token verification is local.Infra access via Keycloak must remain independent.Service-to-service via SPIFFE/mTLS must remain independent.
   If Supabase down means the entire platform stops, the split is wrong.

Scenario 2: Keycloak is down
Question:
Can infra operators perform emergency repair?Can existing internal sessions continue?Can external app users still use Supabase-authenticated apps?
Expected answer:
Break-glass infra access exists.Existing infra sessions have short TTL and cached verification.External users should not depend on Keycloak unless accessing internal resources.

Scenario 3: OPA is down
Question:
Does the system fail open or fail closed?
Expected answer:
Sensitive resource access fails closed.Low-risk cached decisions may continue for short TTL.Emergency break-glass path must be explicit and audited.

Scenario 4: CMP is down
Question:
Can marketing access continue?Can treatment/payment/contractual access continue?
Expected answer:
Purpose-bound processing requiring consent should fail closed.Some legal-basis flows may continue if policy allows and evidence exists.All degraded decisions must be audited.

Scenario 5: JWT header is tampered
Question:
Can a user add headers claiming tenant_id/admin role?
Expected answer:
No. Gateway ignores user-supplied platform headers.It validates external token, then mints internal signed principal token.Services trust only signed internal token + mTLS identity.

Scenario 6: User is authenticated but not MDM-resolved
Example:
Ankush logs in as app user in travel app.A medical record refers to Ankush as patient.Are they the same person?
Expected answer:
Auth session identity and MDM identity remain separate until resolution.The system may create POSSIBLY_SAME link, not force merge.Sensitive cross-domain joins require high-confidence evidence and policy approval.
This is precisely why MDM is needed.

Scenario 7: OPA allows API access but UI hides field
Question:
Can the API still leak hidden fields?
Expected answer:
Field masking must happen server-side.UI visibility is advisory.API response must be shaped by obligations.

Scenario 8: One app uses Supabase RLS, another uses OPA
Question:
Can the same data be visible in one app but denied in another?
Expected answer:
For non-sensitive app-owned data, yes.For platform-governed data, no; OPA/Platform Policy must be authoritative.

Scenario 9: Sidecar fails open
Question:
If sidecar is misconfigured, can service bypass policy?
Expected answer:
No. Services must enforce policy at code boundary too.Sidecar provides transport trust, not final business authorization.

Scenario 10: AI wrongly links two people
Question:
How do we detect, undo, and audit the false link?
Expected answer:
AI produces suggestion, not direct merge.Links have confidence, provenance and status.High-risk links require steward approval.Unlink creates compensating event, not delete.

5. What is positive in the design
   The meeting has several strong foundations.
   5.1 Separating infra and platform is correct
   The team correctly distinguishes infra from platform:
   Infra = machines, clusters, networking, GitOps, VPN, container registryPlatform = identity, consent, ABAC, observability, eventing, MDM, service communication
   That separation is necessary.
   5.2 MDM is correctly understood as data identity
   The patient/doctor/radiologist example is very good. It shows why user login identity is insufficient. A person can exist in the platform as data long before they are a logged-in user.
   This aligns strongly with the RealMDM doctrine: Person is pure; patient, doctor, radiologist, driver, customer, employee are contextual projections.
   5.3 Go for core platform services is reasonable
   For MDM, ABAC integration, event consumers, service registry adapters, high-throughput APIs, and internal gRPC contracts, Go is a strong choice. The instinct to avoid putting the entire platform core in FastAPI/Node is defensible.
   5.4 GitOps and ownership concern is mature
   The ownership concern around droplets and registries is a sign of real platform thinking. If the team enforces GitOps early, it will prevent future chaos.
   5.5 The shell idea is useful
   The shell can become a developer-experience breakthrough if it becomes:
   policy-aware app shell + generated SDK + gateway contract + service-side enforcement
   It should not become one giant monolith.
   5.6 Consent outside perimeter is conceptually right
   Consent capture often begins before internal resource access. For web tracking, marketing, onboarding, cookies, or external onboarding, consent does belong near the edge/outside perimeter. Internal services should receive consent receipts and purpose context.

6. Optimized platform-over-infra architecture
   I would refine the platform into this structure:
   ┌──────────────────────────────────────────────────────────────┐│ Application Experience Layer ││ React / Next / Mobile / Vercel / Internal Apps ││ Uses App Shell + Platform SDK │└──────────────────────────────┬───────────────────────────────┘ │┌──────────────────────────────▼───────────────────────────────┐│ Edge & Session Plane ││ Supabase/Auth Provider for external sessions ││ Keycloak for internal/infra users ││ Session Broker mints Platform Principal Token │└──────────────────────────────┬───────────────────────────────┘ │┌──────────────────────────────▼───────────────────────────────┐│ Trust & Service Connectivity Plane ││ SPIFFE/SPIRE, mTLS, Envoy/service mesh, gRPC contracts │└──────────────────────────────┬───────────────────────────────┘ │┌──────────────────────────────▼───────────────────────────────┐│ Policy & Consent Plane ││ OPA Shell, ABAC/ReBAC, CMP integration, obligations, audit │└──────────────────────────────┬───────────────────────────────┘ │┌──────────────────────────────▼───────────────────────────────┐│ MDM / Real Identity Plane ││ Pure entities, identity handles, crosswalks, canonical IDs ││ relationship contracts, evidence, entity resolution │└──────────────────────────────┬───────────────────────────────┘ │┌──────────────────────────────▼───────────────────────────────┐│ Event & Workflow Plane ││ Kafka/Redpanda Reality Log, NATS/JetStream command bus, ││ Temporal workflows │└──────────────────────────────┬───────────────────────────────┘ │┌──────────────────────────────▼───────────────────────────────┐│ Observability, Audit & Lineage Plane ││ OTel traces, metrics, logs, audit ledger, policy logs, lineage │└──────────────────────────────┬───────────────────────────────┘ │┌──────────────────────────────▼───────────────────────────────┐│ Infrastructure Layer ││ K8s, VMs, droplets, DBs, object storage, registry, VPN, GitOps │└──────────────────────────────────────────────────────────────┘
   Key architectural correction:

MDM, ABAC, consent, observability and shell should not be random services in one flat platform. They should be explicit control planes with contracts between them.

7. Recommended canonical request flow
   External user accessing an app resource
1. User opens app.2. Supabase authenticates user session.3. App Shell receives external session token.4. Platform Gateway validates Supabase token.5. Gateway maps session to Platform Principal.6. Gateway enriches context: - app_id - tenant_id - org_id - bu_id - user_id - device posture - network zone - purpose7. Gateway checks CMP consent receipt if needed.8. Gateway calls OPA shell.9. OPA returns decision + obligations.10. Gateway/service enforces: - allow/deny - row filters - field masks - audit requirement11. Service accesses domain data using canonical MDM IDs.12. Audit event emitted.
   Internal service calling another service
1. Service A calls Service B over gRPC.2. mTLS proves Service A identity via SPIFFE.3. Service A sends internal signed Platform Principal Token.4. Service B verifies: - mTLS identity - token audience - token expiry - request context5. Service B calls OPA for sensitive action.6. Service B emits audit event.
   MDM resolving a non-user person
1. Domain system sends source person/patient/customer record.2. MDM ingests normalized identity handles.3. Deterministic resolver checks exact handles.4. Probabilistic resolver proposes candidate links.5. AI resolver enriches ambiguous cases.6. High-risk match goes to steward/portal.7. MDM assigns or links canonical_person_id.8. Downstream systems store canonical ID, not raw identity truth.

1. What I would change immediately
   Change 1: Rename “shell” into four explicit components
   App ShellPlatform GatewayService SidecarPlatform SDK
   Do not let one word mean all four.
   Change 2: Create a Platform Principal Token
   After Supabase/Keycloak authentication, the platform should mint its own internal token.
   { "sub": "platform-principal:user:u_123", "auth_provider": "supabase", "assurance": "mfa", "app_id": "app_linkedpro", "tenant_id": "tenant_abc", "org_id": "org_xyz", "roles": ["admin"], "session_id": "sess_123", "aud": "platform-services", "exp": 900}
   This prevents raw external tokens from spreading everywhere.
   Change 3: Make OPA return obligations, not just allow/deny
   Example:
   { "allow": true, "obligations": { "mask_fields": ["profit_margin", "ssn"], "filter": { "tenant_id": "tenant_abc" }, "audit": { "level": "sensitive_access" }, "ttl_seconds": 300 }}
   Change 4: Decide Kafka/Redpanda/NATS boundaries now
   Do not let every team pick their favorite bus.
   Recommended:
   Redpanda or Kafka = durable event logNATS JetStream = platform command/control and lightweight internal eventsTemporal = workflowsgRPC = synchronous service APIs
   Pick Kafka or Redpanda as the primary Reality Log. Avoid both unless there is a migration/compatibility reason.
   Change 5: Treat Supabase as external app accelerator, not platform source of truth
   Use Supabase where it accelerates:
   external authmagic linkssocial loginapp sessionsimple app DB/RLSstorage for non-core app assets
   Do not use it as source of truth for:
   canonical identitycross-domain authorizationsensitive platform policyMDMconsent truthaudit truth
   Change 6: Establish platform resource registry
   Every resource must have:
   resource_id:type:environment:owner:team:repo:terraform_module:cloud_account:cost_center:data_classification:network_zone:created_by:approved_by:expires_at:
   No owner = no resource.
   Change 7: Make MDM a platform control-plane service, not an app feature
   MDM should expose APIs:
   ResolveIdentityCreateOrLinkEntityGetCanonicalEntityGetCrosswalkRegisterIdentityHandleProposeLinkApproveLinkRejectLinkExplainIdentity
   Apps should not “own” person truth. They own domain transactions.

1. Optimized platform pillars
   Pillar 1 — Trust Plane
   Purpose:
   Prove who/what is calling.
   Components:
   Keycloak for internal infra usersSupabase/external IdP for external app usersSPIFFE/SPIRE for service identitymTLS for service-to-service transportPlatform Principal Token for normalized internal identity
   Pillar 2 — Policy Plane
   Purpose:
   Decide what is allowed.
   Components:
   OPA shellpolicy context servicepolicy data storedecision audit logobligation enforcement libraryadmin consolepolicy simulator
   Pillar 3 — Consent Plane
   Purpose:
   Decide whether processing purpose is permitted.
   Components:
   external CMPconsent receipt storepurpose taxonomyconsent lookup APIrevocation eventsintegration into OPA input
   Pillar 4 — MDM Plane
   Purpose:
   Resolve real-world data identity.
   Components:
   pure entity registryidentity handle registrycrosswalk registryrelationship contractsevidence storeentity resolution engineAI suggestion queuesteward workflowcanonical ID service
   Pillar 5 — Event & Workflow Plane
   Purpose:
   Make changes durable and replayable.
   Components:
   Kafka/RedpandaNATS/JetStreamTemporalevent schema registryidempotency ledgerreplay tools
   Pillar 6 — Observability/Audit/Lineage Plane
   Purpose:
   Know what happened, why, who did it, and what it affected.
   Components:
   OpenTelemetryGrafanaPrometheusLoki/ELKaudit ledgerpolicy decision loglineage eventssecurity event stream
   Pillar 7 — Developer Experience Plane
   Purpose:
   Make app developers use the platform correctly by default.
   Components:
   App ShellPlatform SDKgRPC clientsAPI templatesOPA helper libraryconsent helper libraryMDM resolver clientgolden-path examples

1. Questions I need answered for the next deep dive
   A. Platform scope

What exactly is “platform” expected to own in version 1?

Is the platform meant to support only internal apps first, or external SaaS apps from day one?

Is the platform single-company internal, or multi-tenant SaaS from the beginning?

Is app_id + tenant_id + org_id + bu_id already fixed as the global scope model?

What is the first real application that will use this platform?

B. Supabase vs Keycloak

Are you using Supabase only for Auth, or also Postgres, RLS, Storage, Realtime and Edge Functions?

Are external customer users always authenticated by Supabase?

Are internal company users always authenticated by Keycloak?

Can one person be both internal user and external customer?

Will Keycloak trust Supabase as an upstream identity provider, or will the Platform Gateway handle that trust?

Who mints the final internal platform token?

Are Supabase roles authoritative, or are they merely session claims?

C. OPA / ABAC

Will OPA be central PDP for all platform access decisions?

Should OPA return only allow/deny, or obligations like masking, filters, audit level and TTL?

Where will policy data live?

Who will build the policy admin console?

How will policies be versioned, tested and promoted?

How will developers test policy decisions locally?

What is the expected P99 latency for OPA decisions?

What happens if OPA is unavailable?

D. Consent

Which CMP exists today?

What does the consent receipt look like?

What are the first purpose codes?

Does consent apply only to marketing/tracking, or also data sharing, analytics, AI training, support and healthcare/HR workflows?

What happens when consent is revoked?

Does consent revocation trigger MDM/event updates?

Does CMP sit outside perimeter for all apps, or only public web apps?

E. MDM

What are the first master domains: Person, Organization, Address, Device, Document?

Is MDM expected to resolve only users, or all data subjects including non-users?

What is the first identity resolution use case?

Do we need real-time identity resolution or async stewardship first?

What identifiers are available for matching: email, phone, DOB, address, device, external IDs?

What data is considered toxic and must be tokenized before entering MDM?

What is the false-merge tolerance?

Who approves ambiguous matches?

What graph/database is planned for relationship contracts?

F. Shell / OSL

Is the shell a frontend container, backend gateway, sidecar, SDK, or all of these?

What should app developers import or call?

Does the shell run inside each app, beside each app, or centrally?

Does the shell enforce policy or only fetch context?

Will the shell generate UI visibility rules?

How will the shell handle offline/mobile clients?

What is the versioning strategy for shell contracts?

G. Event backbone

Are Kafka and Redpanda both planned, or is one the preferred long-term backbone?

What is NATS/JetStream used for exactly?

Which events are durable business events vs ephemeral internal messages?

Do we need a schema registry?

What is the event envelope standard?

How are idempotency and replay handled?

What is the first event-driven workflow?

H. Service mesh / mTLS

Are you planning Istio, Linkerd, Consul, or custom Envoy sidecars?

Is SPIFFE/SPIRE already selected?

Who owns certificate issuance and rotation?

Do all internal service calls require mTLS?

How are service identities mapped to OPA subjects?

How do we prevent services from trusting spoofed headers?

I. Observability

What telemetry standard will be used?

Are traces required across frontend → gateway → service → OPA → MDM → DB?

Where do audit logs go?

What is the difference between observability logs and legal audit logs?

Which events must be immutable?

Do we need data lineage from day one?

Who responds to alerts?

J. Infra and GitOps

Which cloud providers are in scope?

What is the Kubernetes strategy?

Is every resource created through Terraform/OpenTofu?

Is ArgoCD/Flux used for GitOps?

What is the resource ownership registry?

Who can create droplets, registries, buckets, clusters and databases?

What is the break-glass process?

K. Team and delivery

Who owns platform architecture?

Who owns MDM service implementation?

Who owns OPA/ABAC?

Who owns CMP integration?

Who owns shell/SDK?

Who owns infra/GitOps?

Who owns observability?

Who writes threat models?

Who approves production readiness?

What is the first 30-day deliverable?

11. My current verdict
    The meeting has the right instinct:

Apps are easy now. The hard thing is the platform underneath them.

That is true.
The strongest ideas are:

- infra vs platform distinction- MDM as data identity, not user auth- Go for core high-throughput platform services- OPA for deeper authorization- consent as purpose-bound context- mTLS for service trust- GitOps and resource ownership- shell/contract layer to simplify app developers
  The biggest risks are:
- unclear boundaries between Supabase, Keycloak, OPA and MDM- shell becoming a god component- two or three independent policy systems- no canonical internal principal model- event backbone ambiguity- observability without audit taxonomy- scale claims without partitioning strategy- resource ownership still informal
  My recommended next step is to freeze the meeting output into a Platform Architecture Decision Record with one diagram, one trust flow, one policy flow, one MDM flow, and one team ownership matrix. Without that, the team will build fragments of five different architectures at once.Sources
