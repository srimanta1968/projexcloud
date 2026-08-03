import { redirect } from 'next/navigation';

/**
 * Keys now live under the application that owns them.
 *
 * This page used to manage keys directly, and did not work: it posted
 * `{name, scope}` fields the schema does not have, rendered columns the API
 * never returned, and sent no Authorization header at all — so against the
 * default-deny gateway every request was a 401 that the page swallowed into an
 * empty table.
 *
 * Kept as a redirect rather than deleted because operators have this URL
 * bookmarked and in runbooks; a 404 would read as "the feature was removed".
 */
export default function ApiKeysPage(): never {
  redirect('/applications');
}
