Investigated. The critical finding shapes everything:

There are three executors, not two

┌──────────────────────────┬────────────────────────────────┬───────────────────────────────────────────────────────────────────────────────────┐
│ executor │ source of truth │ header handling today │
├──────────────────────────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ Dev MCP (Python) │ tests/api_definitions/ on disk │ definition/dataset only; 2-tier {{var:}} │
├──────────────────────────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ Test MCP (Python) │ api_library │ flat variables, pre-resolved by ProjexLight │
├──────────────────────────┼────────────────────────────────┼───────────────────────────────────────────────────────────────────────────────────┤
│ ProjexLight backend (TS) │ api_library │ endpoint.headers + testDataSet.variables merged in APILibraryService.testEndpoint │
└──────────────────────────┴────────────────────────────────┴───────────────────────────────────────────────────────────────────────────────────┘

And the UI's four modes all run through the third one: mode: 'quick' | 'chain' | 'workflow' | 'dataset' | 'manual', with chain via buildMinimalPrerequisiteChain and workflow via api-orchestration.ts:283. Per-env results already land in env_test_results keyed by envId.

So a header feature built only in the dev MCP would work locally and silently not exist in the UI's manual/chain/workflow runs. That's the risk to mitigate, and it's why the contract has to come first.

---

Task list

A. Contract — do this first, it prevents the divergence

- A1 Write the resolution spec once: layer order, placeholder types (var/static/cache/dynamic/date), where secrets may live. Versioned, referenced by all three.
- A2 Canonical config shape: defaultHeaders, environments[env].headers, providers[].match→headers, testCredentials.<role>.headers, computedHeaders.
- A3 ProjexLight storage shape: values as scoped variables via EnvironmentVariableService (encryption + masking already there); header maps as a per-env blob.

B. Dev MCP

- B1 Layered resolution in \_generate_test_request, documented precedence
- B2 Extend {{var:}} from 2 tiers to the spec's tiers
- B3 computedHeaders (HMAC over the finalised body) — unskips the 12 webhook datasets
- B4 Log which layer supplied each header
- B5 Runner-injected auth must never silently override a configured header

C. Test MCP

- C1 Consume the per-env header map (mostly pass-through)
- C2 Shared computedHeaders implementation — same spec, not a reimplementation
- C3 Verify dataset headers survive the merge

D. ProjexLight executor (the one the UI uses)

- D1 Apply layered headers in testEndpoint — today it reads only row-level headers
- D2 Chain mode: propagate through buildMinimalPrerequisiteChain
- D3 Workflow mode: same via orchestration
- D4 Manual mode: show the resolved header set and its source layer, allow override

E. Multi-environment

- E1 Per-env header sets; env_test_results is already per-env so results stay separated
- E2 Env switch in the UI selects the matching layer
- E3 Per-env secrets via the existing encrypted store

F. Distribution

- F1 Extend the split-aware global-var seeder to carry header maps (same path as env params — don't build a second)
- F2 CLI-export README section: precedence table, one worked example per category, secret placement, verification steps

G. Guardrails

- G1 Reviewer rules: requiresRole + explicit Authorization; ambiguous producer; root status matching no dataset; header-layer contradiction
- G2 Generator emits requiresRole, noAuth, capturesResponse
- G3 Parity test — one definition resolved by all three executors must produce identical headers. This is the single highest-value item; without it A–F drift again within a release.

H. Close out first (still open from today)

- LeadFlow 403 fix unverified — the last run still showed 403s and no role-prefetch in the logs
- Login negative dataset still reporting 200
- 10 genuine API defects (7 LeadFlow, 3 ProjexCloud)

I'd finish H before starting A — the role-token path is the same code the header layering will build on, and shipping A–D on top of an unverified fix would make both hard to diagnose. Want me to close H first?
