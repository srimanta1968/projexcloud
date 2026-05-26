# Pricing-catalog seeds

JSON seeds for the `sdk-meter` pricing catalog. Each file declares one
catalog (id + version) and a list of `(sku, unit, mode, price)` rate
rows. Applied via `scripts/apply-pricing-seed.mjs`; the catalog stays
in `draft` status until an operator explicitly promotes it to `active`.

## Available seeds

| Seed | Covers | Purpose |
|------|--------|---------|
| `registry-mcp-v1.json` | `registry.read.*`, `registry.tool.other` | Rates for the SKUs the hosted `services/registry-mcp` emits via its audit→meter sink. |

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
