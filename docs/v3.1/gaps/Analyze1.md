English Translation
Overview

The discussion focused on building a platform layer that integrates identity, consent management, observability, secure service communication, and fine-grained access control across infrastructure and application services. A key theme was clarifying how Supabase, Keycloak, ABAC/OPA, mTLS, and gRPC fit together for both internal and external users, and when a simpler versus a more layered architecture is appropriate. The team also discussed Master Data Management (MDM) as a core identity/data foundation and how engineering ownership, roles, and platform scope should be organized.

Action Items
Prashant will coordinate tracking and status management for the MDM initiative and engage Shikhar whenever technical assistance is required.
Sanjay Tanveer and the team will align on the platform-building approach for MDM and consent management.
The team will decide whether additional personnel should be brought in from the market or from Navratn, as needed.
Prashant will identify whether interns are required and raise that requirement once the scope becomes clearer.
Topics Discussed

1. MDM / AI Delivery Scope and Work Distribution (00:01:32)
   MDM was positioned as a Go-based initiative with Prashant working full-time and handling status tracking.
   The AI team was expected to focus on core AI work, while backend and frontend responsibilities would be handled elsewhere.
   The team discussed aligning people according to skillsets so that those focused primarily on UI or non-AI work could be placed appropriately.
2. Shell / Container Concept and Required Context (00:02:03)
   The "Shell" was described as a container that executes applications step by step while maintaining complete context.
   Required context includes:
   Identity
   ABAC
   Data lineage
   Observability
   Security
   Permissions
   Roles
   Scope
   Application/container scope
   Google Drive and Gmail were used as analogies to explain how the shell surfaces the correct context and permissions.
3. Layering: Shell Components and Ownership Across Teams (00:05:38)
   The shell was divided into layers derived from infrastructure, cloud, identity, observability, and platform components.
   Infrastructure covers:
   VMs
   Droplets
   Kubernetes
   Git repositories
   Platform covers higher-level services.
   Security, MLOps, and data pipelines were expected to reside within the platform layer.
4. Access Ownership and Resource Maintenance (00:08:30)
   Resource creation should be traceable and clearly owned, especially for droplets, Kubernetes clusters, and container registries.
   Concerns were raised about resources being created and deleted without clear ownership.
   GitOps was mentioned as the preferred operating model.
   Justin was identified as the current owner of one of the discussed resources.
5. Returning to "Real Engineering" Behind Applications (00:13:44)
   The discussion shifted from cloud-based application creation toward what actually happens behind application logic.
   A distinction was made between simple applications and enterprise applications.
   The conversation moved into backend and platform engineering concerns.
6. Platform Layer: Identity, Consent, ABAC, and Upgrades (00:15:50)
   The platform layer sits above infrastructure and manages:
   Identity
   Consent
   ABAC (Attribute-Based Access Control)
   Existing consent services require upgrades.
   ABAC work previously handled by Prashant is now considered part of the broader platform experience.
7. Observability and Monitoring (00:16:36)

The platform layer is expected to include:

Observability portal
Telemetry monitoring
Grafana dashboards

Alerts should allow tracing:

Network perimeter activity
What was accessed
Who accessed it
Where it was accessed from

Observability was also linked to visibility into data engineering pipelines.

8. Secure Communications and Event Backbone (00:17:42)
   mTLS was proposed for secure service-to-service communication.
   Kafka and Redpanda were discussed as event backbone options.
   Selection depends on pipeline complexity:
   Redpanda for heavier ingestion/pipeline scenarios.
   Kafka for standard event-driven use cases.
9. Internal Communication Tools (00:19:36)
   Net and JetStream were mentioned as communication tools between CM and MDM-related services.
   While details were not fully clear, they were intended to support internal service communication.
10. Containerization and App Developer Contract Model (00:20:34)
    Applications should not communicate directly with the platform layer.
    An intermediary container should:
    Understand platform integration.
    Provide a contract/interface for application developers.
    The goal is to simplify integration requirements for developers.
11. UI/API Architecture and Protocol Choices (00:21:35)

Frontend:

React
Potentially Next.js

Backend:

FastAPI

Communication:

Node ↔ FastAPI
gRPC preferred for lightweight, structured communication. 12. VPN vs Protocol and Access Layer Concerns (00:22:06)
VPN was considered mandatory for infrastructure access.
Future platform access may also require VPN protection.
gRPC remained the preferred platform communication protocol. 13. Security Layers: mTLS vs gRPC Contracts (00:24:38)

Security was divided into:

Network Security
mTLS
Data Validation & Contracts
gRPC

Authentication exists at two levels:

Infrastructure authentication
Context-aware platform authentication

The discussion emphasized the distinction between transport security and data-level validation.

14. Keycloak, Supabase, and Infrastructure Access Control (00:27:21)

Keycloak was positioned as:

Infrastructure access gatekeeper
Role manager
Access control authority

CIAM/SSO-style approaches were discussed for managing infrastructure services and changes.

mTLS and SPIRE were also mentioned as supporting infrastructure authentication.

15. Supabase vs Keycloak and External Authentication (00:31:03)

Supabase:

Customer-facing authentication
Email login
Google login

Keycloak:

Access control
Identity management

JWT headers and mTLS were discussed as part of the security chain.

16. Authentication vs Authorization Confusion (00:35:52)

The team clarified:

Authentication

Who the user is.

Authorization

What the user is allowed to do.

Supabase, PostgreSQL, and configuration boundaries were discussed to reinforce this distinction.

17. Keycloak as Gateway and Session Workflow (00:39:34)

Questions raised:

Why not handle both authentication and authorization directly at the gateway?
How do policies evolve as infrastructure scales?

Session management and permission handling were discussed after login.

18. Key Management, Zero Trust, and Trust Relationships (00:41:14)
    Access control was compared to a gatekeeper model.
    Concepts aligned with Zero Trust architecture.
    Identity verification must occur before access is granted.

No final architecture decision was recorded.

19. Using Supabase Libraries in the Front End (00:43:51)

Supabase libraries can:

Reduce manual implementation effort.
Simplify authentication.
Simplify authorization integration. 20. Session and Authentication Features: Keycloak vs Supabase (00:45:09)

Keycloak:

Infrastructure authentication provider.

Supabase:

External authentication layer.

Session management responsibilities were discussed.

Access should remain limited to trusted services and internal IT users.

21. Supabase + OPA vs Keycloak Alone (00:53:24)

Discussion centered on whether:

Option A

Keycloak alone is sufficient.

Option B

Supabase + OPA + Keycloak provides additional capabilities.

Observations:

Supabase integrates tightly with PostgreSQL.
Provides real-time features, storage, and session management.
OPA supports advanced scope- and attribute-based authorization. 22. When a Three-System Architecture Is Appropriate (01:03:08)

The team concluded:

For most internal systems, Keycloak alone is usually sufficient.
More complex architectures should only be adopted when Keycloak cannot solve the problem cleanly.
Authorization complexity increases as application count grows. 23. Convincing the CTO About Supabase + OPA + Keycloak (01:04:43)

The CTO believed:

Supabase + OPA + Keycloak is better suited for external SaaS applications.

The presenter sought justification because earlier discussions suggested Keycloak alone might be enough.

No final decision was made.

24. Authorization Flow: From Supabase Session to Service Access (01:07:35)

Flow:

Authentication
Session creation
JWT identity creation
Service access evaluation

Access decisions depend on:

Identity
Attributes
Additional authorization checks

As applications grow, service discovery and deployment awareness become increasingly important.

25. Service-to-Service Routing and Sidecar Mediation (01:11:11)

Requests are routed through a sidecar component.

The sidecar:

Forwards required context.
Enables target services to make authorization decisions. 26. OPA for Authorization and Permission Data (01:12:00)

OPA was proposed as the policy engine for authorization checks.

Additional topics:

Permit-style authorization data
Custom implementation requirements
Need for an administrative console 27. RBAC Using Identity and Attributes (01:12:30)

Roles govern:

Screen access
API access

Examples included:

CEO access
CTO access

Additional controls:

Row-Level Security (RLS)
ABAC-style enforcement 28. Screen-Level and Attribute-Level Enforcement Using OPA and Supabase (01:13:40)

Authorization determines:

Which screens are visible.
Which fields are visible.

Supabase handles:

Role-based controls
Attribute-based controls

OPA handles:

Advanced policy decisions 29. Deployment Boundaries: Supabase, PostgreSQL, and Application Services (01:16:24)
Each service should have its own database.
PostgreSQL was described as an internal database layer.
Clear separation is required between:
Platform
Application
Database responsibilities 30. Consent Management Service and Field Visibility (01:17:55)

Consent management determines:

What users can see.
Which fields are visible.
Whether access is granted or denied.

The service provides visibility rules to applications and UIs.

31. Consent Management, GDPR, and CMP Placement (01:19:54)

Under GDPR:

Consent must be collected before data processing or access.

CMP (Consent Management Platform):

Should sit outside the perimeter.
Internal systems can still process consent-related information. 32. Engineering Ownership, MDM, and Platform Building (01:23:59)

Sanjay Tanveer emphasized:

Automation helps.
Real engineering must still be performed by engineers.

The team discussed collaboration across:

Server-side engineering
Infrastructure
Platform services
MDM
Consent management 33. Master Data Management and Identity (01:25:56)

MDM manages:

Data identity

Not:

User authentication identity

Concepts discussed:

Canonical IDs
Identity resolution 34. Linking Identities Across Systems (01:28:11)

Focus:

Resolving identities across different systems.

Examples:

Patient identities
Doctor identities

AI-based identity matching was discussed.

35. ABAC and Platform Components (01:30:55)

ABAC was identified as part of platform engineering.

Concerns included:

Large datasets
High-volume workflows
Performance
Scalability 36. Work Planning, Capacity, and Tracking

The team discussed:

Alignment across contributors.
Tracking ownership.
Capacity planning.
Improving delivery outcomes over time. 37. Platform Direction and Long-Term Vision

The platform was described as necessary to:

Avoid future bottlenecks.
Prevent unsupported applications.
Enable automation.
Standardize workflows.
Support cloud-native operations. 38. Recommended Starting Point

The team recommended beginning with:

MDM
CMP (Consent Management Platform)
ABAC
Authentication & Authorization Frameworks

These were viewed as foundational building blocks for the broader platform.

Key Architectural Takeaway

The emerging architecture discussed can be summarized as:

External Users
→ Supabase (Authentication & Session Management)

Internal Platform & Infrastructure
→ Keycloak (SSO, IAM, Role Management)

Authorization & Policy Decisions
→ OPA / ABAC

Secure Service Communication
→ mTLS + gRPC

Identity & Data Foundation
→ MDM

Consent & Compliance
→ CMP / Consent Management Service

Observability
→ Grafana + Telemetry + Audit Trails

Event Backbone
→ Kafka or Redpanda

Application Integration
→ Sidecar/Container Layer that abstracts platform complexity from application developers.
