# PRD · P8 — Deployment Variants (parallel from P3 onward)

| Field | Value |
|---|---|
| **Phase** | P8 — runs **in parallel** with P3–P7 once Vault + Pool Router exist (week 22 onward) |
| **Window** | Weeks 22+ (per-variant timeline below) |
| **Maps to wave(s)** | n/a — variant-specific |
| **Gates closed** | — per-variant (no platform-wide gate) |
| **Status** | DRAFT |
| **Owner (DRI)** | Per-variant DRI: BYOK / Sovereign / On-Prem / Active-Active |
| **Companion docs** | `../docs/v3.1/Architecture-v3.1.html` §22A (Deployment Variants) |

---

## 1 · TL;DR

P8 ships **four deployment variants** for enterprise and regulated buyers who cannot run on the default commercial regions. Each variant is **independent** — gated per customer contract, not on the central phase plan. **BYOK / CMEK** lets customer's KMS wrap their tenant key. **Sovereign Cloud** runs platform in isolated regions (FedRAMP · IL5 · China PIPL · EU sovereign). **On-Prem / Air-Gapped** packages the platform as a Kubernetes distribution for banks and government. **Active-Active Tier-G+** offers RPO ≤ 5s · RTO ≤ 60s for life-critical workloads.

---

## 2 · Why parallel (not sequential)

These variants are **deployment topology + operational changes**, not new SDKs. They don't block other phases. They can begin in parallel once Vault (P1) + Pool Router (P1) exist — which is week 9 — and progress on each tenant's own contract timeline. The PRD is one document for all four to keep the variants conceptually together; engineering tracks them separately per customer commit.

The risk of **not** documenting these upfront: SDK design choices made in P3–P7 may bake in assumptions (cloud KMS only, hyperscaler control plane, phone-home telemetry) that block these variants later. By documenting variants now, the SDK exit gates can verify variant-compatibility from the start.

---

## 3 · What ships per variant

### Variant A · BYOK / CMEK

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `sdk-vault` extension | SDK · MODIFIED | M · 4w | Platform | Customer's CMK becomes the wrapping key for the Tenant Key — sits between Pool KEK and Tenant Key |
| BYOK admin UI in Tenant Admin Portal | App update | M · 2w | Platform | Per-tenant CMK connect flow (AWS KMS grant · GCP KMS handle · HSM via PKCS#11) |
| Per-tenant CMK rotation policy | Tooling | S · 1w | Platform | Customer rotates on their cadence; platform re-wraps Tenant Key transparently |
| BYOK audit + SIEM forwarder | Service | M · 3w | Platform | Every CMK use logged to platform Audit + (optionally) shipped to customer's SIEM |

### Variant B · Sovereign Cloud (FedRAMP / IL5 / PIPL / EU sovereign)

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| Sovereign region topology | Infra | L · 8w | Platform Infra | Isolated pool families · KMS · ClickHouse · Iceberg per sovereign region. No data, telemetry, audit, or control-plane signal leaves the region. |
| Sovereign region operator runbook | Doc | M · 4w | Platform Architect + partner | Partnership with in-region MSP (US-cleared for FedRAMP/IL5; Chinese cloud for PIPL); joint-authority support procedures |
| Terraform + Helm bundles for sovereign | Infra | M · 4w | Platform Infra | Container images + IaC delivered as signed bundles to partner |
| Per-region attestation | Compliance | varies | Compliance | SOC2/FedRAMP/PIPL attested per region separately |

### Variant C · On-Prem / Air-Gapped

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| Kubernetes distribution package | Infra | XL · 12w | Platform Infra | Single-cluster footprint: Admin Pool + 1 App Pool per app + Evidence Pool + Vector + Vault + KMS + Kafka + ClickHouse + Temporal — sized for single-tenant or small-network |
| Air-gapped update tooling | Tooling | M · 4w | Platform Infra | Quarterly signed-bundle releases via approved media / one-way data diode; signature validation + migration apply + rollback |
| Local-model AI Gateway | sdk-ai-gateway extension | M · 4w | AI Platform | Runs against local Llama / Mistral via Ollama or vLLM; provider abstraction extended to local |
| Reduced SDK feature flags | Config | S · 1w | Platform | Webhook outbound limited to in-cluster; federation disabled; cross-region replication unavailable |
| Internal-billing report (no invoicing) | sdk-billing extension | M · 3w | Platform | Meter still runs internally; no external invoicing; cost reports for customer's finance |

### Variant D · Active-Active Tier-G+

| Component | Type | Effort | Owner | Notes |
|---|---|---|---|---|
| `sdk-pool-router` extension | SDK · MODIFIED | M · 4w | Platform | Synchronous-replication tier for audit/payment; per-tenant home-region pin with low-latency read replicas in paired regions |
| Per-pool replication mode config | Infra | M · 3w | Platform Infra | Per-SDK replication: sync for audit/payment, async for everything else |
| Monthly chaos drill | Ops | recurring | SRE | Rotate a tenant's home region; if RPO/RTO targets missed, downgrade tier |
| Tier-G+ contract addendum + pricing | Business | — | Sales / Finance | 3–4× infrastructure cost; addendum required |

---

## 4 · User stories

### Variant A — BYOK

- **US-BYOK-1**: As a regulated finance customer, I plug my own AWS KMS CMK as the wrapping key for my Tenant Key; if I revoke the CMK, my data becomes undecryptable across all pools (operational risk surfaced in contract).
- **US-BYOK-2**: As my CMK rotates on my schedule, the platform transparently re-wraps the Tenant Key without re-encrypting leaf data.
- **US-BYOK-3**: I ship CMK use logs to my SIEM (Splunk · Elastic · Sumo).

### Variant B — Sovereign Cloud

- **US-SOV-1**: As a US Federal contractor, my workload runs in FedRAMP-High region operated by a US-cleared MSP; no data leaves the region; SOC2 + FedRAMP attested separately.
- **US-SOV-2**: As a Chinese SaaS customer, my workload runs in China region operated by a Chinese cloud partner; PIPL compliant; no cross-region data flow.

### Variant C — On-Prem / Air-Gapped

- **US-OP-1**: As a bank, my deployment is fully on-prem; quarterly signed-bundle updates via approved media; no phone-home telemetry.
- **US-OP-2**: My AI Gateway runs against locally-hosted Llama 3.1 70B; no cloud LLM provider calls.
- **US-OP-3**: My billing is flat-fee per contract; meter runs internally for cost tracking but no external invoicing.

### Variant D — Active-Active

- **US-AA-1**: As a global payment network, my writes are accepted in 3 regions simultaneously for non-conflict-prone SDKs (audit, telemetry, search); OLTP stays single-region active.
- **US-AA-2**: When my home region fails, traffic auto-routes to paired region within 60s.

---

## 5 · Functional requirements per variant

### 5.A · BYOK

- FR-BYOK-1: Customer's CMK becomes the wrapping key for Tenant Key (sits between Pool KEK and Tenant Key in the hierarchy)
- FR-BYOK-2: Pool KEK is platform-controlled; Tenant Key + everything under it (Person, Encounter, Device, Org) unwrappable only via customer's CMK
- FR-BYOK-3: Customer revoke → service halt for that tenant (contractual: surfaced in change-control protocol)
- FR-BYOK-4: Supported KMS providers: AWS KMS (via grant), GCP KMS (via key handle), HSM (via PKCS#11)
- FR-BYOK-5: Rotation transparent — customer rotates, platform re-wraps Tenant Key
- FR-BYOK-6: Every CMK use logged to platform Audit + optionally shipped to customer's SIEM

### 5.B · Sovereign Cloud

- FR-SOV-1: Sovereign region = isolated pool family (own Admin · App · Evidence · Vector · Warehouse · KMS)
- FR-SOV-2: No data, telemetry, audit, or control-plane signal leaves the region — Pool Router federation manifest treats sovereign as terminal
- FR-SOV-3: Sovereign control plane operated by in-region partner (US-cleared MSP for FedRAMP, Chinese cloud for PIPL)
- FR-SOV-4: Projexlight ships container images + Terraform/Helm; partner runs the cluster
- FR-SOV-5: Remote-only L3 support under joint-authority procedures
- FR-SOV-6: SDK estate identical (the 57 SDKs run unchanged); what changes is topology + operator
- FR-SOV-7: Per-region attestation (SOC2 + FedRAMP + PIPL + EU sovereign — separately)
- FR-SOV-8: Cross-region attestation impossible by design

### 5.C · On-Prem / Air-Gapped

- FR-ONP-1: Single-cluster Kubernetes footprint of the platform
- FR-ONP-2: Sized for single-tenant or small-network (not millions of tenants)
- FR-ONP-3: Air-gapped quarterly signed-bundle releases (approved physical media or one-way diode)
- FR-ONP-4: Update tooling validates signature, applies migrations, rolls back on failure
- FR-ONP-5: AI Gateway operates against locally-hosted models (Llama · Mistral via Ollama/vLLM)
- FR-ONP-6: Webhook outbound limited to in-cluster endpoints
- FR-ONP-7: Federation hooks disabled
- FR-ONP-8: Telemetry stays in-cluster — no phone-home
- FR-ONP-9: Pricing flat-fee + support (not pay-as-you-use); meter runs internally
- FR-ONP-10: sdk-billing produces internal-use reports, not invoices

### 5.D · Active-Active Tier-G+

- FR-AA-1: Conflict-free domain restricted — active-active only for SDKs whose data model tolerates eventual consistency (audit append, telemetry, search indexes, notifications)
- FR-AA-2: OLTP SDKs with strong-consistency requirements stay single-region active (identity, payment, encounter open/close)
- FR-AA-3: Per-tenant home region for OLTP; read replicas in paired regions
- FR-AA-4: Writes to non-home region routed back (with audited cross-region latency)
- FR-AA-5: RPO ≤ 5s · RTO ≤ 60s targets via synchronous replication for audit/payment; async for everything else
- FR-AA-6: Monthly chaos drill rotates a tenant's home region; RPO/RTO miss triggers tier downgrade
- FR-AA-7: Tier-G+ contract addendum (3–4× infra cost)

---

## 6 · Non-functional requirements per variant

| Variant | Dimension | Target |
|---|---|---|
| BYOK | CMK use latency overhead | ≤ 10ms p99 |
| BYOK | CMK rotation propagation | ≤ 15min |
| Sovereign | Cross-region data leak | 0 (audited continuously) |
| Sovereign | Partner-operator handoff | follow joint-authority runbook |
| On-Prem | Update bundle size | ≤ 5GB per quarter |
| On-Prem | Air-gap update apply time | ≤ 2h |
| On-Prem | Local LLM latency (Llama 3.1 70B) | ≤ 3s for 1k-token completion |
| Active-Active | RPO | ≤ 5s |
| Active-Active | RTO | ≤ 60s |
| Active-Active | Cross-region write latency overhead | ≤ 50ms p99 |

---

## 7 · Acceptance criteria (per-variant)

### Variant A · BYOK

| # | Criterion | Test plan |
|---|---|---|
| **AC-BYOK-1** | Customer connects AWS KMS CMK via Tenant Admin; Tenant Key wrapped under CMK | Sandbox AWS KMS test |
| **AC-BYOK-2** | Customer CMK revoke → tenant data undecryptable end-to-end within 30s | Chaos drill |
| **AC-BYOK-3** | CMK rotation transparent — leaf data not re-encrypted; Tenant Key re-wrapped | Rotation test |
| **AC-BYOK-4** | CMK use logs ship to customer's SIEM (Splunk test) | Integration test |

### Variant B · Sovereign Cloud

| # | Criterion | Test plan |
|---|---|---|
| **AC-SOV-1** | Sovereign region operates with no data/control-plane leak | Network audit + DPI |
| **AC-SOV-2** | All 57 SDKs run unchanged in sovereign region | Deploy + smoke test |
| **AC-SOV-3** | Partner-operated cluster successfully receives quarterly signed-bundle update | Runbook walkthrough |
| **AC-SOV-4** | Per-region attestation completed (SOC2 + variant-specific: FedRAMP / PIPL / EU sovereign) | External audit |

### Variant C · On-Prem / Air-Gapped

| # | Criterion | Test plan |
|---|---|---|
| **AC-ONP-1** | Air-gapped install via signed bundle completes on a clean K8s cluster | Install walkthrough |
| **AC-ONP-2** | Air-gapped quarterly update applies + rollback verified | Update drill |
| **AC-ONP-3** | Local LLM (Llama 3.1 70B via Ollama) handles completion within 3s p99 | Load test |
| **AC-ONP-4** | No phone-home telemetry leaves the cluster | Network audit |
| **AC-ONP-5** | Internal-billing report generated for customer finance | Report sample |

### Variant D · Active-Active Tier-G+

| # | Criterion | Test plan |
|---|---|---|
| **AC-AA-1** | RPO ≤ 5s under monthly chaos drill | Chaos drill |
| **AC-AA-2** | RTO ≤ 60s under monthly chaos drill | Chaos drill |
| **AC-AA-3** | OLTP SDKs (identity, payment) correctly route writes back to home region | Routing test |
| **AC-AA-4** | Eventually-consistent SDKs (audit append, telemetry) accept writes in any region | Multi-region write test |

---

## 8 · Test plan (selected)

### AC-BYOK-2 · CMK revoke causes undecryptable data

**Scenario:**
- Customer connects AWS KMS CMK via Tenant Admin
- Tenant Key re-wrapped under customer CMK; data continues to be readable
- Customer revokes the CMK via AWS console
- Within 30s, every read attempt against the tenant's data returns UndecryptableError; clear error surfaced to operations + customer

**Pass condition:** Revoke propagates ≤ 30s; no data leaks via cached keys; recovery process clear (customer re-grants → re-wrap → service resumes).

### AC-ONP-3 · Local LLM performance

**Scenario:**
- Deploy on-prem cluster with Ollama + Llama 3.1 70B
- Issue 100 completion requests of 1000-token output
- Measure p99 latency

**Pass condition:** ≤ 3s p99; correctness comparable to baseline GPT-4 outputs for the test set (within 5% on standard benchmarks).

### AC-AA-1 + AC-AA-2 · Active-Active failover

**Scenario:**
- Tier-G+ tenant with home region us-east-1 and paired region us-west-2
- Synthetic load: 100 req/s; 80% read, 20% write
- Chaos drill: kill us-east-1 cluster

**Pass condition:** RPO ≤ 5s (audit + payment writes lost in the failover window measured ≤ 5s); RTO ≤ 60s (traffic resumes on us-west-2 within 60s); audit chain unbroken across regions.

---

## 9 · Dependencies

Per-variant:
- BYOK: P1 Vault complete (week 9) → start week 10+; ship per customer contract
- Sovereign: P1 Pool Router complete (week 9) + partner agreements signed → variable
- On-Prem: P6A AI Gateway complete (week 40) for local-model support → start week 40+
- Active-Active: P7 Pool Federation runtime complete (week 50) for routing → start week 50+

---

## 10 · Out of scope

- ❌ Sovereign region for jurisdictions not signed up (case-by-case)
- ❌ On-prem deployments smaller than single-cluster (e.g., edge / IoT — separate product)
- ❌ Active-active for SDKs requiring strong consistency (kept single-region active)

---

## 11 · Risks per variant

| Variant | # | Risk | Severity | Mitigation |
|---|---|---|---|---|
| BYOK | R-1 | Customer accidentally revokes CMK | H | Change-control protocol; required customer approval workflow before revoke |
| BYOK | R-2 | KMS provider outage breaks decryption | H | Multi-region KMS replication; documented degraded-mode runbook |
| Sovereign | R-1 | Partner operator misconfigures cluster | H | Standardized bundles + automation; quarterly audits |
| Sovereign | R-2 | Cross-region data leak via misconfigured federation | H | Network policies enforce sovereign isolation; continuous DPI monitoring |
| On-Prem | R-1 | Update bundle gap discovered post-deploy | M | Bundle includes upgrade-path tests; rollback verified before production |
| On-Prem | R-2 | Local LLM accuracy mismatch with cloud baseline | M | Per-tenant model selection; benchmarks per release |
| Active-Active | R-1 | Write conflict in conflict-free domain unexpectedly | M | Limit to truly conflict-free SDKs; CI verifies SDK eligibility |
| Active-Active | R-2 | Cost overrun (3-4× infra) | M | Tier-G+ contract addendum prices it correctly |

---

## 12 · Rollout per variant

- **BYOK**: Customer-by-customer. First reference customer in P3+ window; productize after 3 customers stable.
- **Sovereign**: First sovereign region (likely FedRAMP for a federal contractor) — 6 month build with partner; subsequent regions ~3 months each.
- **On-Prem**: First on-prem reference customer (bank) — 8 month build (depends on P6A for local-model support); productize after 2 customers.
- **Active-Active**: First Tier-G+ customer post-P7; chaos drills every month.

---

## 13 · Open questions / decisions needed

- [ ] Q-1: BYOK CMK revoke notification — automatic email to operators + customer? Or contract-defined escalation only?
- [ ] Q-2: Sovereign partner SLA — who owns L1/L2 support vs Projexlight L3?
- [ ] Q-3: On-prem support tier — annual support fee vs per-incident? Recommended annual
- [ ] Q-4: Active-Active home region change — customer-triggered, operator-triggered, or both?
- [ ] Q-5: Which sovereign region(s) to commit to first? FedRAMP / EU sovereign / China PIPL — depends on first signed customer

---

## 14 · Sign-off (per variant)

| Variant | Role | Name | Date | Status |
|---|---|---|---|---|
| BYOK | Variant DRI | | | |
| BYOK | Security / Compliance | | | |
| Sovereign | Variant DRI | | | |
| Sovereign | Partner Ops | | | |
| On-Prem | Variant DRI | | | |
| On-Prem | Platform Infra | | | |
| Active-Active | Variant DRI | | | |
| Active-Active | SRE | | | |
