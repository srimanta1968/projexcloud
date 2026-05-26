# blueprints/

Vertical blueprints for `projex blueprint apply <id>` (P9 / E4).

A blueprint is a declarative composition of ProjexCloud SDKs that produces
a runnable starter app. Each blueprint lives in its own subdirectory with:

```
<blueprint-id>/
  blueprint.yaml      # schema_version "1.0" — see @projexlight/blueprints
  templates/          # Handlebars-style template files referenced by outputs[]
  seed/               # optional seed-data SQL
  tests/              # optional smoke-test scripts the installer runs
```

## Phase 1 pilots (current)

| id | pack | SDKs |
|---|---|---|
| `revops-crm` | general | sdk-tenant + sdk-identity + sdk-audit + sdk-billing + sdk-meter |

## Phase 2+ planned

| id | pack | SDKs |
|---|---|---|
| `field-dispatch` | general | sdk-dispatch + sdk-assignment + sdk-storm + hdk-map + hdk-camera |
| `claims-intake` | finserv | sdk-workflow + sdk-evidence + sdk-approval + sdk-payment + hdk-image-editor |
| `b2b-analytics` | general | sdk-analytics + sdk-lineage + sdk-semantic + connector-snowflake |
| `patient-portal` | healthcare | sdk-consent + sdk-evidence + sdk-conversation + hdk-camera + sdk-data-rights |
| `prd-management` | general | sdk-projection + sdk-identity + sdk-audit + sdk-ai-gateway + sdk-knowledge-rag (Projexlight dogfood per PRD §5.7) |

## Authoring a new blueprint

1. Create `blueprints/<id>/blueprint.yaml` matching the schema.
2. Add Handlebars templates under `blueprints/<id>/templates/` for each
   `outputs[].template` entry.
3. Run `node -e "console.log(require('@projexlight/blueprints').loadBlueprint({ dir: 'blueprints/<id>' }))"` to
   confirm validation passes.
4. Phase 2 will add a CI gate that loads every blueprint at PR time.

## Phase 2 / E4.F3+ install flow (planned)

```
projex blueprint apply <id>
  → load blueprint
  → resolve every sdks[].name against the local catalog (warn on missing)
  → prompt clarifying_questions[] interactively
  → render each outputs[] template with the answer set + sdk versions
  → write files into the current app dir
  → run tests/smoke.test.ts if present
```
