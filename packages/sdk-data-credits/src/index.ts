/**
 * @projexlight/sdk-data-credits — vendor-abstracted capability broker & credit ledger
 * (P16 · EP-378).
 *
 * A tenant buys an OUTCOME — "validate.phone", "find.contact-points" — and pays in
 * credits. Which vendor served it, on whose key, how healthy that vendor is and what
 * it truly cost are the broker's business and never cross the tenant boundary. That
 * is not a convention here: the internal tables carry no tenant_id, so they cannot
 * appear in a tenant-scoped query without somebody deliberately writing one.
 *
 * The lifecycle is estimate -> reserve -> execute -> settle, where a no-match, a
 * provider failure and a cache hit all settle to ZERO and release the hold — the
 * tenant pays for answers, not for attempts.
 *
 * Vertical-neutral by contract.
 */
export { migrationsDir } from './db';
export * from './services/brokerService';
export * from './services/reservationService';
