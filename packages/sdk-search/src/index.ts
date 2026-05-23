export * as server from './server';
export * as types from './models/search.model';
export { migrationsDir } from './db';
export {
  ensureIndex,
  indexEntity,
  executeQuery,
  createSavedQuery,
  executeSavedQuery,
  getSavedQuery,
  listSavedQueries,
  deleteSavedQuery,
  IndexNotFoundError,
} from './services/searchService';
export {
  registerSearchClient,
  getSearchClient,
  resolveIndexName,
} from './services/searchClient';
export type { SearchClient } from './services/searchClient';
export {
  OpenSearchClient,
  createOpenSearchClient,
  registerOpenSearchClient,
} from './services/openSearchClient';
export type { OpenSearchClientOptions } from './services/openSearchClient';
export {
  enrichWithAbacFilter,
  buildFreeTextQuery,
} from './services/abacFilter';
export {
  registerIndexProjection,
  clearIndexProjections,
  handleEventForIndex,
} from './services/autoIndexer';
export type { IndexProjection } from './services/autoIndexer';
