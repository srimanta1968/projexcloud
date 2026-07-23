/**
 * Minimal, dependency-free RFC 5545 (iCalendar) VEVENT generator for booking invites.
 * Produces a single-event VCALENDAR string suitable for an .ics attachment or a
 * text/calendar response. No external deps — sdk-scheduling stays self-contained.
 */

export interface IcsAttendee {
  email: string;
  name?: string;
  role?: 'REQ-PARTICIPANT' | 'OPT-PARTICIPANT' | 'CHAIR';
}

export interface IcsEventInput {
  /** Stable RFC 5545 UID — MUST be constant across updates to the same event. */
  uid: string;
  /** RFC 5545 SEQUENCE — MUST increase on each update so clients accept the change. */
  sequence?: number;
  start: string | Date;
  end: string | Date;
  summary: string;
  description?: string;
  location?: string;
  organizer?: { email: string; name?: string };
  attendees?: IcsAttendee[];
  /** VEVENT STATUS — CONFIRMED for a booking, CANCELLED for a cancellation invite. */
  status?: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
  /** VCALENDAR METHOD — REQUEST for an invite, CANCEL to withdraw it. */
  method?: 'REQUEST' | 'CANCEL' | 'PUBLISH';
  /** Timestamp used for DTSTAMP; pass a fixed value for reproducible output. */
  dtstamp?: string | Date;
}

/** Format a date to the RFC 5545 UTC form: 20260901T150000Z. */
function toIcsUtc(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** Escape a value per RFC 5545 §3.3.11 (TEXT): backslash, comma, semicolon, newline. */
function escapeText(value: string): string {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Fold lines longer than 75 octets per RFC 5545 §3.1 (CRLF + single space). */
function foldLine(line: string): string {
  if (line.length <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 74) {
    parts.push(' ' + rest.slice(0, 74));
    rest = rest.slice(74);
  }
  if (rest.length) parts.push(' ' + rest);
  return parts.join('\r\n');
}

/**
 * Build a single-event VCALENDAR string. Deterministic given the same inputs
 * (pass a fixed `dtstamp` for byte-stable output, e.g. in tests).
 */
export function generateIcs(input: IcsEventInput): string {
  const lines: string[] = [];
  const push = (l: string) => lines.push(foldLine(l));

  push('BEGIN:VCALENDAR');
  push('VERSION:2.0');
  push('PRODID:-//ProjexCloud//sdk-scheduling//EN');
  push('CALSCALE:GREGORIAN');
  push(`METHOD:${input.method ?? 'REQUEST'}`);
  push('BEGIN:VEVENT');
  push(`UID:${input.uid}`);
  push(`SEQUENCE:${input.sequence ?? 0}`);
  push(`DTSTAMP:${toIcsUtc(input.dtstamp ?? input.start)}`);
  push(`DTSTART:${toIcsUtc(input.start)}`);
  push(`DTEND:${toIcsUtc(input.end)}`);
  push(`SUMMARY:${escapeText(input.summary)}`);
  if (input.description) push(`DESCRIPTION:${escapeText(input.description)}`);
  if (input.location) push(`LOCATION:${escapeText(input.location)}`);
  push(`STATUS:${input.status ?? 'CONFIRMED'}`);
  if (input.organizer) {
    const cn = input.organizer.name ? `;CN=${escapeText(input.organizer.name)}` : '';
    push(`ORGANIZER${cn}:mailto:${input.organizer.email}`);
  }
  for (const a of input.attendees ?? []) {
    const cn = a.name ? `;CN=${escapeText(a.name)}` : '';
    const role = `;ROLE=${a.role ?? 'REQ-PARTICIPANT'}`;
    push(`ATTENDEE${role};PARTSTAT=NEEDS-ACTION;RSVP=TRUE${cn}:mailto:${a.email}`);
  }
  push('END:VEVENT');
  push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}
