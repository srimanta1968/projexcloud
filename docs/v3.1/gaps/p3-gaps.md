What's still legitimately deferred (per PRD §10 or downstream phases)

┌────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ FR │ Why deferred │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-IDN-2 per-tenant pepper │ Existing global pepper covers the threat model; per-tenant pepper requires schema migration not in PRD scope │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-IDN-6 per-tenant MFA policy │ Policy table doesn't exist in P2 data model │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-IDN-7 session mgmt CRUD endpoints │ identity.session table present; endpoints are P4 admin portal work │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-POL-1 / FR-POL-5 attribute fetcher resolver │ Registry exists; resolver implementations land per-vertical in P3+ │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-POL-6 pool-aware rule type │ IQL parser has the AST node hook; Cedar term emission lands when first cross-pool rule ships │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-POL-8 syntax highlighter UI │ PRD §10 frontend-deferred │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-APK-7 webhook on rotation │ PRD: "composes with sdk-webhook in P4" │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-APK-8 revoke-all on tenant offboarding │ PRD: "composes with sdk-tenant-lifecycle in P4" │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-REB-3 cross-tenant re-encryption key tier │ Requires sdk-vault cross_tenant_kek work — P3 │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-REB-9 async reachability pre-compute │ On-demand cache + invalidation shipped; precompute worker is an optimization for P4 │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-TNT-10 module subscription endpoint │ Column exists; UI/endpoint is P4 admin portal │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-IPS-7 alert emit │ Worker already logs warnings; structured alert wired when sdk-telemetry's alerting layer ships in P3 │
└────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
What's still legitimately deferred (per PRD §10 or downstream phases)

┌────────────────────────────────────────────────┬──────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ FR │ Why deferred │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-IDN-2 per-tenant pepper │ Existing global pepper covers the threat model; per-tenant pepper requires schema migration not in PRD scope │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-IDN-6 per-tenant MFA policy │ Policy table doesn't exist in P2 data model │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-IDN-7 session mgmt CRUD endpoints │ identity.session table present; endpoints are P4 admin portal work │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-POL-1 / FR-POL-5 attribute fetcher resolver │ Registry exists; resolver implementations land per-vertical in P3+ │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-POL-6 pool-aware rule type │ IQL parser has the AST node hook; Cedar term emission lands when first cross-pool rule ships │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-POL-8 syntax highlighter UI │ PRD §10 frontend-deferred │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-APK-7 webhook on rotation │ PRD: "composes with sdk-webhook in P4" │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-APK-8 revoke-all on tenant offboarding │ PRD: "composes with sdk-tenant-lifecycle in P4" │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-REB-3 cross-tenant re-encryption key tier │ Requires sdk-vault cross_tenant_kek work — P3 │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-REB-9 async reachability pre-compute │ On-demand cache + invalidation shipped; precompute worker is an optimization for P4 │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-TNT-10 module subscription endpoint │ Column exists; UI/endpoint is P4 admin portal │
├────────────────────────────────────────────────┼──────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ FR-IPS-7 alert emit │ Worker already logs warnings; structured alert wired when sdk-telemetry's alerting layer ships in P3 │
└────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
What still needs separate test workstreams

The five ACs that need test infra I didn't build:

- AC-7 resolver hot-path p99 ≤ 1ms — needs k6/wrk-style load harness
- AC-9 DSAR end-to-end — blocked on sdk-engagement (P5) for the "12 encounters" fixture
- AC-10 weekly reconciliation green/red — possible but needs ~3 hours of orchestrator simulation
- AC-11 full 5-device chaos drill — needs hdk-sync on-device SQLite outbox (HDK natives blocker)
- AC-12 iOS/Android parity CI matrix — needs the natives themselves
