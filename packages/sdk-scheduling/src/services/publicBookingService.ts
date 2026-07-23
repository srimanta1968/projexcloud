import { randomBytes } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import {
  bookAppointment,
  computeAvailability,
  type AvailabilityResult,
  type AppointmentRow,
} from './availabilityService';
import { cancelBooking, confirmBooking } from './bookingService';

/**
 * Public (anonymous) booking for sdk-scheduling (P14·E2, TK-3620).
 *
 * This is the invitee-facing half of scheduling: a prospect opens a shared link
 * and books without any tenant login. Everything here therefore assumes a
 * HOSTILE, unauthenticated caller:
 *
 *  - The slug is the only entry point, and it resolves ONLY active, unexpired
 *    links. An inactive or expired link is a flat 404 — never a 403 that would
 *    confirm the slug exists.
 *  - Responses expose only what a booking page needs. tenant_id and internal ids
 *    are never returned, so a slug cannot be used to enumerate a tenant.
 *  - The link's own guardrails are enforced server-side (max_days_ahead,
 *    min_notice_minutes). A client that posts an arbitrary start_time cannot book
 *    two years out or thirty seconds from now.
 *  - Confirm/cancel are keyed on a high-entropy public_token, never on
 *    appointment_id, so a caller cannot act on someone else's meeting.
 */

const LINK_PUBLIC_COLS = `link_id, tenant_id, host_persona_id, meeting_type_id, slug, title,
  description, is_active, max_days_ahead, min_notice_minutes, expires_at`;

export interface PublicLinkRow {
  link_id: string;
  tenant_id: string;
  host_persona_id: string;
  meeting_type_id: string | null;
  slug: string;
  title: string | null;
  description: string | null;
  is_active: boolean;
  max_days_ahead: number;
  min_notice_minutes: number;
  expires_at: string | null;
}

/** The safe projection handed to an anonymous caller — no tenant/host ids. */
export interface PublicLinkView {
  slug: string;
  title: string | null;
  description: string | null;
  max_days_ahead: number;
  min_notice_minutes: number;
  duration_minutes: number | null;
}

/** Thrown when the slug does not resolve to a bookable link. */
export class SchedulingLinkNotBookable extends Error {
  constructor(public slug: string) {
    super(`[sdk-scheduling] no bookable scheduling link for slug ${slug}`);
    this.name = 'SchedulingLinkNotBookable';
  }
}

/** Thrown when a requested time violates the link's booking window. */
export class BookingWindowError extends Error {
  constructor(message: string) {
    super(`[sdk-scheduling] ${message}`);
    this.name = 'BookingWindowError';
  }
}

/**
 * Resolve a slug to a bookable link. Returns null (never a partial row) when the
 * link is missing, deactivated, or past its expiry — the caller turns that into
 * a 404 so all three cases are indistinguishable from outside.
 */
export async function resolveBookableLink(slug: string): Promise<PublicLinkRow | null> {
  const link = await dataService.one<PublicLinkRow>(
    `SELECT ${LINK_PUBLIC_COLS} FROM scheduling.scheduling_link
      WHERE slug = $1 AND is_active = true
        AND (expires_at IS NULL OR expires_at > now())`,
    [slug],
  );
  return link ?? null;
}

/** Duration for the link's meeting type, when one is pinned. */
async function linkDurationMinutes(link: PublicLinkRow): Promise<number | null> {
  if (!link.meeting_type_id) return null;
  const mt = await dataService.one<{ duration_minutes: number }>(
    `SELECT duration_minutes FROM scheduling.meeting_type WHERE meeting_type_id = $1`,
    [link.meeting_type_id],
  );
  return mt?.duration_minutes ?? null;
}

/** Public view of a link for rendering the booking page. */
export async function getPublicLinkView(slug: string): Promise<PublicLinkView | null> {
  const link = await resolveBookableLink(slug);
  if (!link) return null;
  return {
    slug: link.slug,
    title: link.title,
    description: link.description,
    max_days_ahead: link.max_days_ahead,
    min_notice_minutes: link.min_notice_minutes,
    duration_minutes: await linkDurationMinutes(link),
  };
}

/**
 * Open slots for a link on one date. The date is rejected when it falls outside
 * the link's window, so an anonymous caller cannot probe the host's calendar
 * arbitrarily far ahead.
 */
export async function getPublicAvailability(slug: string, date: string): Promise<AvailabilityResult> {
  const link = await resolveBookableLink(slug);
  if (!link) throw new SchedulingLinkNotBookable(slug);
  assertWithinWindow(link, `${date}T00:00:00Z`, { ignoreNotice: true });

  return computeAvailability({
    tenant_id: link.tenant_id,
    host_persona_id: link.host_persona_id,
    date,
    meeting_type_id: link.meeting_type_id ?? undefined,
  });
}

export interface PublicBookInput {
  slug: string;
  start_time: string;
  end_time?: string;
  invitee_name: string;
  invitee_email: string;
  timezone?: string;
  notes?: string;
}

export interface PublicBookResult {
  appointment: AppointmentRow;
  /** Capability token — the ONLY key the public confirm/cancel routes accept. */
  public_token: string;
}

/**
 * Book through a public link.
 *
 * end_time is derived from the meeting type when the caller omits it, so a
 * client cannot silently book a 6-hour slot against a 30-minute meeting type.
 * Double-booking is prevented by bookAppointment's transactional conflict check.
 */
export async function publicBook(input: PublicBookInput): Promise<PublicBookResult> {
  const link = await resolveBookableLink(input.slug);
  if (!link) throw new SchedulingLinkNotBookable(input.slug);
  assertWithinWindow(link, input.start_time);

  const duration = await linkDurationMinutes(link);
  const end_time =
    input.end_time ??
    new Date(new Date(input.start_time).getTime() + (duration ?? 30) * 60_000).toISOString();

  const appointment = await bookAppointment({
    tenant_id: link.tenant_id,
    host_persona_id: link.host_persona_id,
    meeting_type_id: link.meeting_type_id ?? undefined,
    title: link.title || `Booking with ${input.invitee_name}`,
    start_time: input.start_time,
    end_time,
    timezone: input.timezone,
    notes: input.notes,
    // Must match the appointment_source_check CHECK vocabulary exactly.
    source: 'public_link',
    attendees: [{ name: input.invitee_name, email: input.invitee_email, role: 'invitee' }],
  });

  // 32 bytes of entropy — not guessable, and unique per booking.
  const public_token = randomBytes(32).toString('base64url');
  // Public bookings land as 'pending', NOT 'confirmed' (the column default that
  // suits the authenticated API). The invitee's email is unverified at this
  // point, so double opt-in is what makes the confirmation route meaningful and
  // stops an unverified address from holding a confirmed slot on the host's
  // calendar. Confirming via the token moves it pending -> confirmed.
  const updated = await dataService.one<AppointmentRow>(
    `UPDATE scheduling.appointment
        SET public_token = $2, scheduling_link_id = $3, status = 'pending', updated_at = now()
      WHERE appointment_id = $1
      RETURNING appointment_id, tenant_id, host_persona_id, subject_persona_id, meeting_type_id,
                title, description, start_time, end_time, timezone, status, location_type,
                location_detail, meeting_url, attendees, notes, source, created_at, updated_at`,
    [appointment.appointment_id, public_token, link.link_id],
  );

  return { appointment: updated ?? appointment, public_token };
}

/** Look up an appointment by its capability token (tenant comes from the row). */
async function byToken(token: string): Promise<{ tenant_id: string; appointment_id: string } | null> {
  return dataService.one<{ tenant_id: string; appointment_id: string }>(
    `SELECT tenant_id, appointment_id FROM scheduling.appointment WHERE public_token = $1`,
    [token],
  );
}

/** Confirm a publicly booked appointment using its token. Null when unknown. */
export async function confirmByToken(token: string): Promise<AppointmentRow | null> {
  const found = await byToken(token);
  if (!found) return null;
  return confirmBooking(found.tenant_id, found.appointment_id);
}

/** Cancel a publicly booked appointment using its token. Null when unknown. */
export async function cancelByToken(token: string, reason?: string): Promise<AppointmentRow | null> {
  const found = await byToken(token);
  if (!found) return null;
  return cancelBooking(found.tenant_id, found.appointment_id, reason);
}

/**
 * Enforce the link's booking window server-side. The client is untrusted, so
 * max_days_ahead and min_notice_minutes are checked here rather than only being
 * reflected in the UI.
 */
function assertWithinWindow(
  link: PublicLinkRow,
  start_time: string,
  opts: { ignoreNotice?: boolean } = {},
): void {
  const start = new Date(start_time).getTime();
  if (!Number.isFinite(start)) throw new BookingWindowError('start_time is not a valid timestamp');

  const now = Date.now();
  const latest = now + link.max_days_ahead * 86_400_000;
  if (start > latest) {
    throw new BookingWindowError(`start_time is beyond the link's ${link.max_days_ahead}-day booking window`);
  }
  if (!opts.ignoreNotice) {
    const earliest = now + link.min_notice_minutes * 60_000;
    if (start < earliest) {
      throw new BookingWindowError(`start_time is inside the link's ${link.min_notice_minutes}-minute minimum notice`);
    }
  } else if (start < now - 86_400_000) {
    throw new BookingWindowError('date is in the past');
  }
}
