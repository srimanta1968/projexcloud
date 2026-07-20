/**
 * @projexlight/sdk-scheduling — calendar, booking & no-show engine (P14·E2).
 *
 * Surface: migrationsDir (scheduling schema, TK-3618) + the availability slotting &
 * booking service and its Fastify routes. Ports projex_crm calendar.service: per-weekday
 * business hours (IANA-tz aware), reusable meeting types (15/30/45/60 min), timezone-
 * correct slot generation, and double-booking prevention — re-homed tenant-scoped and
 * persona-keyed. Public booking + confirmation routes land with TK-3623; booking
 * lifecycle + ICS + scheduling links with TK-3624; reminders / no-show with TK-3625.
 */
export { migrationsDir } from './db';
export * as server from './server';
export * from './services/availabilityService';
export * from './services/bookingService';
export { generateIcs } from './services/ics';
export type { IcsEventInput, IcsAttendee } from './services/ics';
