# ⚠️ API Definition Description / Error-Case Gaps (MUST-42 / MUST-43)

Single reused backlog — regenerated every commit; entries drop off as they are
fixed. Each api_definition below is missing a QA-grade `description` (what it does
+ EDGE CASES) and/or a root-level `errorCases` array (every error the handler
returns: {status, code, message, when}). These feed **api_library.description**
and the **LLM test-data generator**. Fix EVERY file below — read each handler to
enumerate real errors; do not guess.

- [ ] `GET /api/agent-runtime/agents/:id` — tests/api_definitions/agent-runtime-agents/id-get.json → missing: richer description w/ edge cases (MUST-42)
- [ ] `GET /api/ai-gateway/health` — tests/api_definitions/ai-gateway/health-get.json → missing: errorCases[] (MUST-43)
- [ ] `INTERNAL_FUNCTION internal://sdk-ai-gateway/completionService.emitCompletionEvent` — tests/api_definitions/ai-gateway/meter-byok-sku-switch.json → missing: errorCases[] (MUST-43)
- [ ] `EVENT_CONTRACT events://ai_gateway.tenant_credential` — tests/api_definitions/ai-gateway/tenant-credential-events-contract.json → missing: errorCases[] (MUST-43)
- [ ] `GET /api/commands/stream/:asset_id` — tests/api_definitions/commands/stream-asset-id-get.json → missing: errorCases[] (MUST-43)
- [ ] `GET /api/mcp/health` — tests/api_definitions/mcp/health-get.json → missing: errorCases[] (MUST-43)
- [ ] `GET /api/meter/health` — tests/api_definitions/meter/health-get.json → missing: errorCases[] (MUST-43)

Call `projexlight_get_api_definition_rules` for the exact format.