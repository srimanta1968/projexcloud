/**
 * @projexlight/connector-snowflake — public surface.
 *
 * P6B · OAuth + Snowflake account connect. Bidirectional sync: ProjexCloud
 * Iceberg lakehouse ↔ customer Snowflake tables. Query federation — agents
 * query the customer's warehouse, gated by capability token + meter.
 * Tool manifest auto-registers in sdk-semantic CapabilityGraph on install.
 *
 * Initial drop: Postgres migration + contracts. Full installSnowflake /
 * bindTable / syncTable / query executors land in follow-up tasks under
 * feat_snowflake.
 */
export { migrationsDir } from './db';

// P7 FR-LH-6 — Snowflake ↔ Iceberg bridge.
export {
  syncBindingNow,
  resolveIcebergBinding,
  registerSnowflakeClient,
  registerIcebergClient,
  getRegisteredClients,
} from './services/icebergBridge';
export type {
  SnowflakeClient,
  IcebergClient,
  SyncOutcome,
} from './services/icebergBridge';
