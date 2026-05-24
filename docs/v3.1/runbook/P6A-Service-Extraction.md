# P6A Service Extraction Roadmap (S-1 / TK-3321)

PRD §3 names three new services that today run inside the prototype `services/api-gateway`:

| Service | Hosts | Extract when |
|---|---|---|
| `services/ai-gateway-service` | sdk-ai-gateway routes + provider adapter registry | gateway QPS > 500/s OR provider key isolation required for compliance |
| `services/agent-runtime-service` | sdk-agent-runtime routes + TTL enforcer + replay engine + namespace boot check | agent_run write rate > 100/s OR memory pressure from execution_log payloads exceeds 4 GB resident |
| `services/trace-collector` | sdk-trace routes + ClickHouse bootstrapper + span ingest | span ingest rate > 5k/s OR trace.span Postgres mirror lags > 2s |

## Common extraction checklist

For every extracted service:

1. **Carve the package set.** Each service hosts ONE primary SDK plus its required upstreams (db-runtime, kafka-runtime, sdk-audit, sdk-meter, sdk-pool-router). Mirror the dependency block from `services/api-gateway/package.json`.
2. **Boot lifecycle.** Copy these from api-gateway's `start()`:
   - `initPool` · `initRedis` · `initKafka`
   - `runMigrations[<just this service's SDK migration dir>]`
   - The SDK's bootstrap calls (e.g. `bootstrapLLMCredentials` for ai-gateway-service, `assertVectorNamespaceIsolation + startTtlEnforcer + startLogRetentionWorker + startSigningKeyRotation` for agent-runtime-service)
   - `app.register(<sdk>.server.registerRoutes)`
3. **Auth.** Keep the same `requireAuth` pre-handler from sdk-identity. JWT shape is global.
4. **Trace context hook.** Install `installTraceContextHook(app)` first so AC-11 propagation continues to work.
5. **Pool routing.** Add the migration runner call BEFORE service startup so per-pool schemas exist when the first request lands.
6. **Migration owner.** Each extracted service runs migrations only for its own SDK + its upstream operational tables (e.g., `agent-runtime-service` runs `agents.*` only, not `mcp.*`).

## Deployment topology

```
                                                                ┌─────────────────────────┐
                                                                │ trace-collector         │
                                                                │ - sdk-trace             │
                                                ┌─────────────► │ - ClickHouse bootstrap  │
                                                │   spans       │ - signed export bundles │
                                                │               └─────────────────────────┘
                          ┌────────────────────┐│
        ┌───────────────► │ ai-gateway-service ├┘
        │ /complete       │ - sdk-ai-gateway   │
        │ /stream         │ - provider regs    │
        │                 │ - LLM cred vault   │
        │                 └────────┬───────────┘
        │                          │ provider calls
        │                          ▼
┌──────────────┐            ┌─────────────────────────────┐
│  api-gateway │            │ agent-runtime-service       │
│ (router /    │ /tokens    │ - sdk-agent-runtime         │
│  gateway     ├──────────► │ - TTL enforcer worker       │
│  health)     │ /runs      │ - replay engine             │
│              │ /rollback  │ - namespace boot check      │
│              │            │ - signing-key rotation      │
│              │            │ - log retention worker      │
│              │            │ - kill-switch sweep         │
│              │            └─────────────────────────────┘
└──────────────┘
```

## Triggers — when to actually extract

| Service | Metric trigger | Owner |
|---|---|---|
| ai-gateway-service | sustained 500 req/s for 2 weeks OR Anthropic API key rotation cadence demands per-cluster isolation | AI Platform |
| agent-runtime-service | agent_run insert rate > 100/s OR p99 capability-token mint > 8ms (within budget but trending) | AI Platform |
| trace-collector | span ingest rate > 5k/s OR trace.trace.total_latency_ms drift > 2s vs ClickHouse mirror | Platform / Observability |

## Out of scope (P6A)
- sdk-mcp-bridge stays in api-gateway — its hot path is dominated by external HTTP round-trips, extraction doesn't help latency.
- sdk-taxonomy stays in api-gateway — pure lookup, tiny footprint.
- connector-github stays in api-gateway — webhook ingest volume is bounded by upstream rate-limit.
