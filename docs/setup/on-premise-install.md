# On-premise installation — licensee guide

For a customer who licenses ProjexCloud and runs it on their own infrastructure. It takes you
from an empty host to a verified install, and tells you up front everything you must supply,
so you never have to learn a requirement from a stack trace.

Read [required-settings-matrix.md](./required-settings-matrix.md) alongside this; it is the
reference for every individual setting. This guide is the order to do things in.

---

## 1. What you are installing

| Component | Required | Notes |
|---|---|---|
| `api-gateway` | **Yes** | One Fastify service that mounts ~90 SDKs. Applies every SDK's database migration and provisions platform secrets on boot. |
| PostgreSQL 16 with **pgvector** and **PostGIS** | **Yes** | The gateway aborts on boot without both extensions. The bundled image `scripts/setup/postgres.Dockerfile` has them. The database must be empty or a previous ProjexCloud database. |
| Redis 7 | Recommended | Without it the route cache and soft-cap counters are per-process. |
| ClickHouse 24 | Recommended | Analytics, trace OLAP, meter rollups and billing showback splits. Without it, billing reads the Postgres day ledger (no app / BU / persona splits). Tuned for a 1.4 GB container in `infra/clickhouse/config.d/` — do not run it on defaults. |
| Kafka | Optional | Falls back to an in-process emitter on a single host. |
| Portals (workspace / tenant / console) | Optional | Next.js apps in front of the gateway. |

### Sizing — a starting point, not a measurement

- **Single host:** 2 vCPU / 4 GB RAM minimum to run, more to build. The image build compiles
  ~90 packages; build in CI and pull the image if the host is small.
- **Postgres:** start at 2 GB / 1 vCPU and size to your data.
- **ClickHouse:** the shipped tuning assumes a 1.4 GB container.

Measure under your own load before you commit to hardware. For pool-based scale-out, see
`docs/v3.1/SCALING-RUNBOOK.md`.

---

## 2. Secrets: what is generated for you, what you supply

### You supply exactly one root: the secrets KMS

Everything the platform generates is sealed under it, so it has to live **outside** the
database. Choose one:

| Option | Set | When |
|---|---|---|
| Software master key | `SECRETS_MASTER_KEY` (32 random bytes, hex or base64) | Single host, no KMS. `prod-setup.sh` generates it into `.env.prod` on first run. |
| AWS KMS | `SECRETS_KMS_PROVIDER=aws-kms` + an instance role or `AWS_ROLE_ARN` | AWS |
| GCP KMS | `SECRETS_KMS_PROVIDER=gcp-kms` + `GOOGLE_APPLICATION_CREDENTIALS` | GCP |
| HSM | `SECRETS_KMS_PROVIDER=hsm-pkcs11` + `HSM_PKCS11_LIB`, `HSM_PKCS11_PIN` | Air-gapped, regulated |

> **Back up `SECRETS_MASTER_KEY` with the same care as the database, but separately from it.**
> Lose it and every generated secret, and so every PII envelope, is unrecoverable. Store
> it in the same backup as the database and anyone holding that backup can decrypt it.

With none of these set, a production gateway refuses to boot. It will not fall back to the
in-memory mock KMS, because every secret sealed under the mock is lost on the next restart.

### Generated on first boot — leave these unset

On its first boot the gateway generates each of these from 32 CSPRNG bytes. It stores each one
envelope-encrypted in `vault.bootstrap_secret` and reads the same value back on every
restart, redeploy and replica:

`JWT_SECRET`, `API_KEY_PEPPER`, `CAPABILITY_TOKEN_SIGNING_KEY`, `SOURCE_RECORD_MASTER_KEY`,
`SOURCE_RECORD_ATTESTATION_KEY`, `EVIDENCE_LEGAL_EXPORT_SIGNING_KEY`,
`NOTIFICATION_MASTER_KEY`, `NOTIFICATION_PROVIDER_WRAP_KEY`, `PRINCIPAL_TOKEN_WRAP_KEY`.

These are safe to generate because none has an external counterparty: nothing outside the
gateway has to hold the same value. `JWT_SECRET` qualifies too. Only the gateway verifies
session tokens, and because the keyring is shared and persistent, sessions survive a restart.

**To supply one yourself** (for example, from your secret manager), set it **before the first
boot**, then never change or remove it. Data is encrypted under it, and the gateway refuses
to boot when:

- a supplied key **changes**. Rows written under the old value would be unreadable. If the
  change is intended, set `BOOTSTRAP_SECRETS_ACCEPT_CHANGE=<NAME>`.
- a supplied key **disappears**. The gateway will not generate a replacement over it. Put
  the same value back.

`BOOTSTRAP_SECRETS=off` turns generation off. You then supply all nine, and the boot fails on
any that are missing.

### You must still supply

| Variable | Why it cannot be generated |
|---|---|
| `DB_PASSWORD` (and `DB_HOST`, `DB_USER`, …) | Your database's credential |
| `ADMIN_OPS_TOKEN` | The operator break-glass credential. You need to know it to call `/admin/*`. |
| `CORS_ORIGIN` | Your front-end origin |
| Third-party credentials (§3) | Each belongs to an account you hold with that provider |

A value containing `change-me` / `CHANGE_ME` / `do-not-use-in-prod` is treated as a
placeholder and refused. A placeholder is worse than an absent value: it looks configured.

---

## 3. Third-party services

None of these can be generated. When one is absent the gateway still boots, because leaving
some of them out is a legitimate install choice. The boot log prints each one as `MISSING`
with what stops working, and the affected endpoints fail loudly instead of degrading
quietly.

| Service | Configure with | If absent | Air-gapped substitute |
|---|---|---|---|
| **OpenSearch** | `OPENSEARCH_NODE` (+ `OPENSEARCH_USERNAME` / `OPENSEARCH_PASSWORD`) | `/api/search` and indexing return 500. There is no Postgres fallback. | OpenSearch in-cluster |
| **Email** | `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASSWORD`, or `SENDGRID_API_KEY` | Notification email is not delivered | An in-cluster SMTP relay |
| **LLM provider** | `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | No platform model. Tenants can still bring their own key. | Ollama or vLLM, registered in `onprem.local_llm_model` ([local-llm-and-discovery.md](./local-llm-and-discovery.md) §5) |
| **Object storage** | `MEDIA_S3_BUCKET`, `AWS_REGION`, credentials; `S3_ENDPOINT` for a non-AWS store | `POST /api/media/upload-url` cannot issue URLs, and every media and evidence flow behind it stops | MinIO (`S3_ENDPOINT=http://minio:9000`; path-style addressing is used automatically) |
| **Secrets KMS** | §2 | The gateway does not boot | PKCS#11 HSM or `SECRETS_MASTER_KEY` |
| **BYOK KMS** | AWS KMS / GCP KMS / PKCS#11 | Tenants cannot bind a customer-managed key | PKCS#11 HSM |
| **Payments** | `STRIPE_SECRET_KEY` | Payments and invoice push are unavailable | None: payments need the processor |

An air-gapped install cannot reach any hosted provider. Use the substitute column, and see
FT-1081 (P8 Variant C) for the offline bundle and update-signing model.

### Synthetic flags

`ALLOW_SYNTHETIC_*=true` lets an SDK run a **fake** implementation in production. Search on an
in-memory map, uploads that go nowhere, emails that are swallowed. They exist for sandboxes.
Do not set any of them on a real install. The boot log prints each one that is on as an
error. The full list is in [required-settings-matrix.md](./required-settings-matrix.md) Class B.

---

## 4. `NODE_ENV=production` — and why a green local run proves nothing

Below `NODE_ENV=production`, several SDKs quietly use dev key material (constants published in
this repository) and synthetic backends, so that a developer laptop works with no setup. At
`production` they refuse instead. That is why:

- a local test suite can pass 100% against an install that cannot encrypt a single PII value;
- the only way to know an install works is to run §6 **on the install itself**.

Always run deployed environments, staging included, with `NODE_ENV=production`. Secret
generation is on by default only there. Elsewhere it is off, because local data may already
be written under the dev constants. `BOOTSTRAP_SECRETS=on` enables it in any environment.

---

## 5. Install

On the host, from a checkout of the release:

```bash
cp scripts/setup/.env.prod.example .env.prod
$EDITOR .env.prod                 # DB_*, ADMIN_OPS_TOKEN, CORS_ORIGIN, third parties (§3)
scripts/setup/prod-setup.sh --mode selfhosted   # or --mode managed for an external Postgres/Redis
```

`prod-setup.sh` refuses to continue on any `CHANGE_ME` placeholder. It generates
`SECRETS_MASTER_KEY` into `.env.prod` if no KMS is configured (**back it up now**), builds and
starts the stack, and waits for `GET /health`.

On the first boot the gateway, in order:

1. applies every SDK migration (`[migrator] applied …` lines);
2. selects the secrets KMS (`secrets KMS provider: …`);
3. generates the platform secrets and prints **one preflight block**. Every required secret
   shows as `present` or `generated`, and every third party not configured shows as `MISSING`.

A new tenant gets its vault key on demand, at its first upload. No seed script is involved.
Never run anything under `tests/setup_scripts/` on a customer install. Those files are QA
fixtures (see that directory's README).

---

## 6. Verify the install yourself

Run these against the installed gateway, not a local copy.

1. **Health:** `curl -s https://<host>/health` returns `{"status":"ok",…}`.
2. **Preflight block:** `docker compose … logs api-gateway | grep '\[preflight\]'`. Expect
   `9/9 required secrets usable`, and **no** `MISSING` line for a service you meant to
   configure. Every `MISSING` line names the variable that fixes it.
3. **Sign up a tenant:** `POST /api/auth/signup-tenant` returns `201` and a token.
4. **PII is really encrypted:** with that token, `POST /api/source-records`, then
   `POST /api/source-assertions` with `is_pii: true`. The response `value` must begin with
   `v1.`. That prefix is the envelope, and it is the proof that a real key is in use rather
   than a dev constant. In production, a missing key makes this a 500, never a silent pass.
5. **Uploads (if object storage is configured):** `POST /api/media/upload-url` for the new
   tenant returns `201` with an `upload_url` on your bucket or endpoint.
6. **Survives a restart:** restart the gateway. The preflight now shows each secret as
   `generated — read back from vault.bootstrap_secret`, not `new on this boot`. The token from
   step 3 still works, and step 4's assertion is still readable.

If step 6 shows `new on this boot` a second time, the keyring is not persisting. Stop and
check that the database is the same one, before any customer data is written.

### Backups

Back up **both** the database and the KMS root (`.env.prod`'s `SECRETS_MASTER_KEY`, or your
cloud KMS key policy), and keep them apart. Restoring the database without its KMS root gives
you rows you cannot decrypt.
