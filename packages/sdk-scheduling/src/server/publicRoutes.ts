import { FastifyInstance } from 'fastify';
import {
  getPublicLinkView,
  getPublicAvailability,
  publicBook,
  confirmByToken,
  cancelByToken,
  SchedulingLinkNotBookable,
  BookingWindowError,
} from '../services/publicBookingService';
import { DoubleBookingError } from '../services/availabilityService';

/**
 * PUBLIC (anonymous) booking surface for sdk-scheduling (P14·E2, TK-3620).
 *
 * These routes are NOT behind requireAuth — the invitee is a prospect with no
 * tenant login — so the gateway's default-deny authGate allowlists the
 * /api/scheduling/public/ prefix. Every route is written for an untrusted
 * caller: slugs resolve only to active/unexpired links, an unknown or
 * deactivated link is an indistinguishable 404, booking windows are enforced
 * server-side, and confirm/cancel accept ONLY the capability token issued at
 * booking time (never a raw appointment_id).
 */
export async function registerPublicRoutes(app: FastifyInstance): Promise<void> {
  // Render-the-page payload for a booking link.
  app.get<{ Params: { slug: string } }>('/api/scheduling/public/links/:slug', async (req, reply) => {
    const link = await getPublicLinkView(req.params.slug);
    if (!link) return reply.code(404).send({ error: 'NotFound' });
    return reply.code(200).send({ data: { link } });
  });

  // Open slots for one date on that link.
  app.get<{ Params: { slug: string }; Querystring: { date?: string } }>(
    '/api/scheduling/public/links/:slug/availability', async (req, reply) => {
      if (!req.query.date) {
        return reply.code(400).send({ error: 'ValidationError', details: ['date query param required (YYYY-MM-DD)'] });
      }
      try {
        const availability = await getPublicAvailability(req.params.slug, req.query.date);
        return reply.code(200).send({ data: { availability } });
      } catch (err) {
        if (err instanceof SchedulingLinkNotBookable) return reply.code(404).send({ error: 'NotFound' });
        if (err instanceof BookingWindowError) {
          return reply.code(400).send({ error: 'BookingWindowError', message: err.message });
        }
        throw err;
      }
    },
  );

  // Book a slot. Returns the appointment plus the capability token the invitee
  // needs to confirm or cancel later.
  app.post<{ Params: { slug: string } }>(
    '/api/scheduling/public/links/:slug/book', async (req, reply) => {
      const body = (req.body ?? {}) as {
        start_time?: string; end_time?: string; invitee_name?: string;
        invitee_email?: string; timezone?: string; notes?: string;
      };
      if (!body.start_time || !body.invitee_name || !body.invitee_email) {
        return reply.code(400).send({
          error: 'ValidationError',
          details: ['start_time, invitee_name and invitee_email are required'],
        });
      }
      try {
        const result = await publicBook({
          slug: req.params.slug,
          start_time: body.start_time,
          end_time: body.end_time,
          invitee_name: body.invitee_name,
          invitee_email: body.invitee_email,
          timezone: body.timezone,
          notes: body.notes,
        });
        return reply.code(201).send({
          data: {
            appointment: result.appointment,
            public_token: result.public_token,
          },
        });
      } catch (err) {
        if (err instanceof SchedulingLinkNotBookable) return reply.code(404).send({ error: 'NotFound' });
        if (err instanceof BookingWindowError) {
          return reply.code(400).send({ error: 'BookingWindowError', message: err.message });
        }
        if (err instanceof DoubleBookingError) {
          return reply.code(409).send({ error: 'DoubleBooking', message: 'that slot was just taken' });
        }
        throw err;
      }
    },
  );

  // Confirm via the capability token. An unknown token is a 404 — it must not
  // reveal whether the token was wrong or the appointment merely absent.
  app.post<{ Params: { public_token: string } }>(
    '/api/scheduling/public/appointments/:public_token/confirm', async (req, reply) => {
      const appointment = await confirmByToken(req.params.public_token);
      if (!appointment) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { appointment } });
    },
  );

  // Cancel via the capability token.
  app.post<{ Params: { public_token: string } }>(
    '/api/scheduling/public/appointments/:public_token/cancel', async (req, reply) => {
      const body = (req.body ?? {}) as { reason?: string };
      const appointment = await cancelByToken(req.params.public_token, body.reason);
      if (!appointment) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { appointment } });
    },
  );
}
