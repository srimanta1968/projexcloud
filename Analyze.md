Yes — the LLM generates it; the platform only instructs. The distinction I drew is about who writes the JSON: MUST-70 + MUST-38 + the DEV_MCP.md examples are delivered to the agent every task, and the agent authors defaultHeaders / providers[] / testCredentials / computedHeaders itself. The only deterministic generator is the {{var:}} auto-populator, which scaffolds variable slots and nothing else. That matters because instruction-only compliance degrades silently: the agent gets it right when the rule is fresh in context and pastes headers per-definition when it isn't, and nothing fails. Two fixes below close that.

PRD: docs/v3.1/prd/Header-Contract-Auth-PRD.html — house style of the existing integration PRD, self-contained. Covers what's built, the fix list with file references and acceptance criteria, legacy-auth support matrix, the LLM auto-config gap, the security analysis, guardrails, a 5-phase rollout, and open decisions.

Fix now — 13 items

P0 — the contract isn't actually in force, so green reports aren't evidence

1. FIX-01 · Multi-suite cycle runs ship no contract at all. SecureTestCycleExecutionService.ts:303 builds its own container env and calls neither buildHeaderContractEnv() nor plainCustomEnvVars() — unlike the single-suite path at test-suite-management.ts:1264. Same suite, different headers depending on how it was launched, and the cycle path is the one used for full regression.
2. FIX-02 · The MCP auth fixes exist only in source. Both MCPs run as Nuitka images; until scripts/build_full.sh --push and a dev-MCP dist rebuild, cloud runs still inject a token into every noAuth/401 dataset that lacks a literal "headers": {}.
3. FIX-03 · Path params resolve in the UI and not in either MCP. UI handles :param, {param}, {{param}}; both MCPs handle :param only, and the Test MCP's substitution returns early when there's no :. MUST-22 explicitly permits {id}, so an OpenAPI-style definition passes in the UI and sends a literal {userId} from both MCPs.

P1 — divergence and unmaintainability

4. FIX-04 · Test MCP wipes all headers on a negative dataset, where the other three drop only the credential — decision needed before the fixture can pin it.
5. FIX-05 · No UI writes the contract. headerContract is read by the resolver and written by no screen; today it's hand-edited JSON in a DB column.
6. FIX-06 · The API Library panel applies 3 of 7 layers because its Environment type never loads custom_env_vars — same endpoint, two answers depending on which screen.
7. FIX-07 · MUST-70 has no reviewer check. Only MUST-38 is enforced; a header pasted into 30 definitions, a secret literal in a header map, or requiresRole + Authorization together all pass.
8. FIX-08 · The auto-populator scaffolds variables but never header layers — the same pass can promote a repeated header and leave {{var:}} slots.
9. FIX-11 · Auth scheme is environment-wide, so a run touching ProjexCloud and a customer's legacy system can't authenticate to both. Needs providers[].auth.
10. FIX-12 · computedHeaders signs raw_body only — enterprise schemes (SigV4, Azure SharedKey, WSSE) sign a canonical string and need timestamp/nonce headers emitted first.

P2

11. FIX-09 · Verify the noAuth round trip through append-datasets and the UI dataset editor.
12. FIX-10 · The fixture covers headers only — path params, query params and the auth schemes have no conformance coverage, and every divergence found so far was in that class.
13. FIX-13 · Audit secret masking across MCP run logs, the HTML report and any resolved-header preview.

Everything from this session is still uncommitted across the three repos (ai-appgen, projex_mcp, and the doc copies in ProjexCloud). Say the word and I'll stage one coherent commit per repo — or start on FIX-01, which is a contained change and the one that makes regression results trustworthy again.
