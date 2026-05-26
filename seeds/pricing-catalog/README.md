# Pricing-catalog seeds

JSON seeds for the `sdk-meter` pricing catalog. Each file declares one
catalog (id + version) and a list of `(sku, unit, mode, price)` rate
rows. Applied via `scripts/apply-pricing-seed.mjs`; the catalog stays
in `draft` status until an operator explicitly promotes it to `active`.

## Available seeds

| Seed | Covers | Purpose |
|------|--------|---------|
| `registry-mcp-v1.json` | `registry.read.*`, `registry.tool.other` (8 SKUs) | Rates for the SKUs the hosted `services/registry-mcp` emits via its audit→meter sink. |
| `foundation-sdks-v1.json` | vault / billing / tenant / meter / identity / audit / pool-router / rebac / policy / secrets / projection (30 SKUs across 11 SDKs) | Overage rates for the platform-foundation tier every tenant inherits. Tuned for sub-cent per-unit pricing; plan ceilings absorb most usage. |
| `vertical-sdks-v1.json` | evidence / payment / workflow / conversation / approval / consent / data-rights / webhook / api-keys / ai-gateway / knowledge-rag / tenant-lifecycle / notification / hdk-image-editor / hdk-camera (45 SKUs across 15 SDKs) | Vertical-tier add-on SDKs customers install per use case. Rates reflect actual compute / network / provider passthrough cost — DSAR fan-out priced at dollars per request; per-call ops at fractions of a cent. |
| `connector-sdks-v1.json` | Salesforce / HubSpot / Slack / Jira / Linear / Zoom / Zendesk / GitHub / M365 / Google Workspace / Snowflake (45 SKUs across 11 connectors) | Per-install monthly fees + per-event metering. Provider-side costs (Twilio SMS, Snowflake warehouse seconds, Zoom storage) pass through unchanged via separate billing channels. |
| `field-ops-sdks-v1.json` | dispatch / assignment / storm / hdk-map / sdk-device (14 SKUs across 5 SDKs) | Field-operations tier; backs the field-dispatch pilot. Storm-spawn batches priced lower than direct enqueue. |
| `analytics-sdks-v1.json` | analytics / lineage / semantic (10 SKUs across 3 SDKs) | Iceberg lakehouse extract per GB, federated query per call, ontology-driven intent resolution. Backs b2b-analytics. |
| `long-tail-sdks-v1.json` | 22 long-tail SDKs (84 SKUs) — search / recommendation / persona / profile / event / trace / taxonomy / feature-flags / geo / parsing / agent-runtime / service-request / onprem / sovereign / social / identity-resolver / diagnostic-telemetry / hdk-measure / hdk-scanner / hdk-video-editor / hdk-watermark / mcp-bridge | Closes catalog coverage to every customer-billable SDK. Sovereign region setup priced in thousands (one-time); per-call ops down to micro-cents for traces + flag evaluations. |

## Applying

```
# Dry-run first
node scripts/apply-pricing-seed.mjs seeds/pricing-catalog/registry-mcp-v1.json --dry-run

# For real (catalog created in draft status)
node scripts/apply-pricing-seed.mjs seeds/pricing-catalog/registry-mcp-v1.json --operator ops-bot

# Promote to active when reviewed
# (use sdk-meter.setCatalogStatus from the admin console or a one-off script)
```

## Editing rates

Rates are recorded per `(catalog_id, version, sku)`. To change a rate:

1. Bump the seed's `version` field
2. Update the `rates[]` entry
3. Re-run the apply script — it creates the new catalog version + leaves
   the prior version untouched (immutability for historic invoices)
4. Promote the new version when ready

Never edit a retired catalog; the script blocks it (and so does
`upsertPricingRate`).

## Notes on the registry-mcp-v1 rates

Per-call rates are deliberately low (sub-cent) because the registry MCP
is a discovery surface — usage scales with developer activity, not
end-customer transactions. The intent is to make pricing transparent
without throttling adoption.

- `registry.read.scaffold` priced higher (~2 mils) because scaffold
  generation is CPU-heavier than the cached reads.
- `registry.tool.other` exists as a catch-all so new tools added in
  future hosted-MCP versions never silently bill at zero. Tune as
  needed when each new tool ships.
