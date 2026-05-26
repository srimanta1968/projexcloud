/**
 * @projexlight/cli — P9 / E5
 *
 * Public surface for embedding the CLI's command modules in tests + the
 * future cloud-builder agent. The bin entry (src/cli.ts) parses argv and
 * dispatches to these functions.
 */

export { runInit, type InitFlags, type InitResult } from './commands/init';
export { runRegistryRefresh, type RefreshFlags, type RefreshResult } from './commands/registry';
export {
  loginStub,
  deployStub,
  installStub,
  blueprintStub,
  type StubOutput,
} from './commands/stubs';
export {
  writeMcpConfigs,
  knownConfigPaths,
  PROJEX_REGISTRY_KEY,
  type AiTool,
  type McpServerEntry,
  type ToolDetection,
  type WriteOptions,
  type WriteResult,
} from './configWriters';
export {
  projexHome,
  projexCacheDir,
  projexConfigPath,
  userCatalogPath,
  userEmbeddingsBinPath,
  userEmbeddingsMetaPath,
} from './paths';
