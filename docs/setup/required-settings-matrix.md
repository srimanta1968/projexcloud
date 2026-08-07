# Required settings — what you must supply, and what we generate

Applies to every deployed environment (staging, production, on-premise). Read this
before an install, not after the first 500.

## Why this document exists

Several SDKs behave differently under `NODE_ENV=production`. Below that threshold they
fall back to synthetic implementations and hardcoded dev key material; at it, they refuse
to start the operation and say so. That is deliberate — a fabricated key must never
encrypt a customer's PII — but it has a consequence worth stating plainly:

> **A green local test run does not prove a working install.**

`sdk-search` locally serves an in-process `Map`. `sdk-source-record` locally encrypts with
`Buffer.alloc(32, 11)` — a constant, published in this repository. Both pass their tests.
Neither is doing the thing its test appears to prove. Measured on 2026-08-06: a suite that
scored 695/695 locally scored 660/695 against production, and **every one of the 35
differences was configuration, not code** — zero routing failures on either side.

So: work through this matrix before declaring an install healthy.

---

## Class A — secrets you generate yourself

No external party is involved. Generate each with a CSPRNG and keep it secret.

```bash
openssl rand -hex 32     # 64 hex characters
```

| Variable | SDK | Protects |
|---|---|---|
| `SOURCE_RECORD_MASTER_KEY` | sdk-source-record | AES-256-GCM envelope over PII assertion values |
| `SOURCE_RECORD_ATTESTATION_KEY` | sdk-source-record | HMAC signature on rights attestations |
| `EVIDENCE_LEGAL_EXPORT_SIGNING_KEY` | sdk-evidence | Signature on legal evidence exports |
| `NOTIFICATION_MASTER_KEY` | sdk-notification | Destination (email/phone) envelope |
| `NOTIFICATION_PROVIDER_WRAP_KEY` | sdk-notification | Provider credential wrapping |
| `PRINCIPAL_TOKEN_WRAP_KEY` | sdk-principal-token | Principal token wrapping |
| `CAPABILITY_TOKEN_SIGNING_KEY` | sdk-agent-runtime | Agent capability token signatures |
| `API_KEY_PEPPER` | sdk-api-keys | Pepper for API key hashing |
| `JWT_SECRET` | sdk-identity | Session token signatures |

### These are not casually rotatable

`SOURCE_RECORD_MASTER_KEY` is the HKDF input for envelopes stored in the database, and the
stored `key_ref` records the *scheme* (`local:hkdf/sdk-source-record/assertion/v1`), **not
which key produced it**. Change the key after data exists and every prior envelope becomes
undecryptable, with nothing on the row to distinguish old from new. The same applies to
`NOTIFICATION_MASTER_KEY` and `PRINCIPAL_TOKEN_WRAP_KEY`.

**Set these before the system writes its first record.** Rotating `JWT_SECRET` is milder —
it only invalidates live sessions.

### Two values that are refused

Any of these keys containing `change-me` or `do-not-use-in-prod` aborts startup. That guard
exists because a placeholder copied from an example file is worse than an absent value: it
looks configured.

---

## Class B — synthetic-mode flags

Each flag lets an SDK run a fake implementation under `NODE_ENV=production`. They exist for
sandboxes. **Every one of them is a decision, and the default for a real install is "do not
set".**

| Flag | If `true` in production |
|---|---|
| `ALLOW_SYNTHETIC_SEARCH_CLIENT` | Search runs on an in-process `Map`. Indexes vanish on every restart — **silent data loss**. Never set this. |
| `ALLOW_SYNTHETIC_BYOK` | Customer-managed keys are simulated. The BYOK guarantee — customer revoke makes tenant data undecryptable — is **not actually delivered**. |
| `ALLOW_SYNTHETIC_AI_PROVIDERS` | Model calls are stubbed; no real inference. |
| `ALLOW_SYNTHETIC_STORM` | Weather/storm data is fabricated. |
| `ALLOW_SYNTHETIC_LEAK_DETECTOR` | Sovereign egress leak detection is not enforced. |
| `ALLOW_SYNTHETIC_S3_SIGNER` | Presigned upload URLs do not point at real storage — uploads **appear to succeed and go nowhere**. |
| `ALLOW_SYNTHETIC_PAYMENT_PROVIDERS` | Payments are simulated. Nothing is charged, captured or settled. |
| `ALLOW_SYNTHETIC_NOTIFICATION_PROVIDERS` | Email and SMS are swallowed. Recipients are never contacted. |

That is the complete set — eight flags, confirmed by sweeping `ALLOW_*` across every SDK.
Three of them (`S3_SIGNER`, `PAYMENT_PROVIDERS`, `NOTIFICATION_PROVIDERS`) were missed by an
earlier pass that searched only for `NODE_ENV === 'production'` guards, because they are
structured differently. If you are auditing this yourself, grep the flag names, not the
guard shape.

If you set one, record why and when it will be removed. A synthetic flag left on in
production is indistinguishable, from the outside, from a working feature.

---

## Class C — third-party services you must provide

These cannot be generated. Each one is absent by default and the affected endpoints fail
loudly rather than degrade quietly.

| Service | Wire-up | Absent behaviour |
|---|---|---|
| **OpenSearch** (or compatible) | `registerSearchClient(new OpenSearchClient(...))` before boot | `GET/POST /api/search`, `POST /api/search/index` return 500 |
| **Webhook HMAC resolver** | `registerHmacKeyResolver(...)` to a vault-backed resolver | Outbound webhook delivery worker fails on every tick |
| **SMTP or SendGrid** | `SMTP_*` or `SENDGRID_API_KEY` | Notification delivery unavailable |
| **LLM provider** | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`, or a local Ollama/vLLM endpoint | AI gateway unavailable unless synthetic is enabled |
| **S3-compatible storage** | signer registration | `POST /api/media/upload-url` cannot issue presigned URLs |
| **KMS or HSM** | AWS KMS / GCP KMS / PKCS#11 | Required for real BYOK (Variant A) |
| **ClickHouse** | `CLICKHOUSE_URL` + credentials | Analytics and trace OLAP degraded |

### Air-gapped installs

An air-gapped deployment cannot reach any hosted third party. Substitute in-cluster:
OpenSearch in-cluster, Ollama or vLLM for the LLM provider, MinIO for S3, an in-cluster
SMTP relay, and a PKCS#11 HSM for KMS. See `FT-1081 (Variant C)` for the bundle and
update-signing model.

---

## Class D — per-tenant configuration

Not environment variables in the usual sense; these are set per tenant after install.

| Setting | Effect if absent |
|---|---|
| `LEAD_FORM_SECRET` / `LEAD_FORM_SECRET_<PLATFORM>` | Inbound lead-form webhooks return `500 SIGNING_SECRET_NOT_CONFIGURED`. The 5xx is deliberate: no signing secret is *our* misconfiguration, and a 4xx would send the provider hunting for a fault in a request that was already correct. |
| Vault tenant key | `POST /api/media/upload-url` returns `400 VaultKeyMissing`, and every media/evidence endpoint downstream of a blob id becomes unreachable. |

---

## Class E — test fixtures, deliberately absent

Files under `tests/setup_scripts/` are QA fixtures and **do not run on a deployed stack**.
If an endpoint only passes because a fixture row exists, it will not pass in production, and
that is correct. Known cases: the webhook DLQ deliveries and the smoke widget ids.

---

## Verifying an install

1. `GET /health` returns 200.
2. Read the boot log. Every `[migrator] applied …` line is expected; any
   `no … registered for production` line names a Class C gap you have not filled.
3. Confirm each Class A variable is present in the running container, not merely in the
   env file:
   ```bash
   docker exec <gateway> sh -c '[ -n "$SOURCE_RECORD_MASTER_KEY" ] && echo present || echo MISSING'
   ```
4. Exercise one endpoint per class-A SDK. For `sdk-source-record`, `POST /api/source-assertions`
   with `is_pii: true` should return 201 and a `value` beginning `v1.` — that prefix is the
   envelope, and it is the only proof the real key is in use rather than the dev constant.
5. Do **not** treat a passing local suite as a substitute for steps 2–4.

### A caution about cascading skips

A failing producer suppresses everything downstream of it, and a suppressed endpoint reports
as skipped rather than failed. During the 2026-08-06 audit a missing
`EVIDENCE_LEGAL_EXPORT_SIGNING_KEY` was invisible to the whole suite because the evidence
endpoints were already being skipped for an unrelated reason — a missing vault key three
steps upstream. **A skip is not a pass.** Read the skip reasons, not just the failure count.
