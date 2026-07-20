import { FastifyInstance } from 'fastify';
import { requireAuth } from '@projexlight/sdk-identity';
import {
  createMeetingType,
  listMeetingTypes,
  upsertAvailabilityRule,
  listAvailabilityRules,
  computeAvailability,
  bookAppointment,
  listAppointments,
  getAppointment,
  DoubleBookingError,
  InvalidTimeRangeError,
} from '../services/availabilityService';
import {
  confirmBooking,
  rescheduleBooking,
  cancelBooking,
  generateAppointmentIcs,
  listBookingEvents,
  createSchedulingLink,
  listSchedulingLinks,
  getSchedulingLink,
  AppointmentNotFoundError,
  InvalidBookingTransitionError,
} from '../services/bookingService';
import {
  scheduleReminders,
  listReminders,
  runReminderTick,
  runNoShowScan,
  rebookAppointment,
} from '../services/reminderService';

/**
 * sdk-scheduling Fastify routes (P14·E2, TK-3618). Availability slotting foundation:
 * meeting types, per-weekday business hours, timezone-correct slot computation, and
 * appointment booking with double-book prevention. All tenant-authed (requireAuth);
 * tenant_id is carried in the body/query as in the sibling sdk-sequence surface.
 *
 * Public booking links, confirmation and ICS land with TK-3623/3624; this task ships
 * the internal calendar core those routes build on.
 */
export async function registerRoutes(app: FastifyInstance): Promise<void> {
  /* ------------------------------------------------------------ meeting types */
  app.post('/api/scheduling/meeting-types', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; name: string; slug: string; host_persona_id: string; description: string;
      duration_minutes: number; buffer_before_minutes: number; buffer_after_minutes: number;
      location_type: string; location_detail: string; metadata: Record<string, unknown>;
    }>;
    if (!body.tenant_id || !body.name || !body.slug) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, name and slug are required'] });
    }
    try {
      const meeting_type = await createMeetingType({
        tenant_id: body.tenant_id, name: body.name, slug: body.slug, host_persona_id: body.host_persona_id,
        description: body.description, duration_minutes: body.duration_minutes,
        buffer_before_minutes: body.buffer_before_minutes, buffer_after_minutes: body.buffer_after_minutes,
        location_type: body.location_type, location_detail: body.location_detail, metadata: body.metadata,
      });
      return reply.code(201).send({ data: { meeting_type } });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === '23505') return reply.code(409).send({ error: 'Conflict', details: ['a meeting type with this slug already exists for the tenant'] });
      throw err;
    }
  });

  app.get<{ Querystring: { tenant_id?: string } }>(
    '/api/scheduling/meeting-types', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      }
      const meeting_types = await listMeetingTypes(req.query.tenant_id);
      return reply.code(200).send({ data: { meeting_types } });
    },
  );

  /* ------------------------------------------------------- availability rules */
  app.post('/api/scheduling/availability-rules', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; host_persona_id: string; weekday: number; start_time: string; end_time: string;
      timezone: string; slot_interval_minutes: number; is_active: boolean;
    }>;
    if (!body.tenant_id || !body.host_persona_id || body.weekday === undefined) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, host_persona_id and weekday are required'] });
    }
    if (body.weekday < 0 || body.weekday > 6) {
      return reply.code(400).send({ error: 'ValidationError', details: ['weekday must be 0 (Sunday) through 6 (Saturday)'] });
    }
    const rule = await upsertAvailabilityRule({
      tenant_id: body.tenant_id, host_persona_id: body.host_persona_id, weekday: body.weekday,
      start_time: body.start_time, end_time: body.end_time, timezone: body.timezone,
      slot_interval_minutes: body.slot_interval_minutes, is_active: body.is_active,
    });
    return reply.code(201).send({ data: { rule } });
  });

  app.get<{ Querystring: { tenant_id?: string; host_persona_id?: string } }>(
    '/api/scheduling/availability-rules', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id || !req.query.host_persona_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id and host_persona_id query params required'] });
      }
      const rules = await listAvailabilityRules(req.query.tenant_id, req.query.host_persona_id);
      return reply.code(200).send({ data: { rules } });
    },
  );

  /* ---------------------------------------------------- availability slotting */
  app.get<{ Querystring: {
    tenant_id?: string; host_persona_id?: string; date?: string; meeting_type_id?: string; slot_minutes?: string;
  } }>(
    '/api/scheduling/availability', { preHandler: requireAuth }, async (req, reply) => {
      const { tenant_id, host_persona_id, date, meeting_type_id, slot_minutes } = req.query;
      if (!tenant_id || !host_persona_id || !date) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, host_persona_id and date query params are required'] });
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return reply.code(400).send({ error: 'ValidationError', details: ['date must be an ISO date (YYYY-MM-DD)'] });
      }
      const availability = await computeAvailability({
        tenant_id, host_persona_id, date, meeting_type_id,
        slot_minutes: slot_minutes ? Number(slot_minutes) : undefined,
      });
      return reply.code(200).send({ data: { availability } });
    },
  );

  /* ------------------------------------------------------------- appointments */
  app.post('/api/scheduling/appointments', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; host_persona_id: string; title: string; start_time: string; end_time: string;
      subject_persona_id: string; meeting_type_id: string; description: string; timezone: string;
      location_type: string; location_detail: string; meeting_url: string; attendees: unknown[];
      notes: string; entity_ref: string; source: string;
    }>;
    if (!body.tenant_id || !body.host_persona_id || !body.title || !body.start_time || !body.end_time) {
      return reply.code(400).send({
        error: 'ValidationError',
        details: ['tenant_id, host_persona_id, title, start_time and end_time are required'],
      });
    }
    try {
      const appointment = await bookAppointment({
        tenant_id: body.tenant_id, host_persona_id: body.host_persona_id, title: body.title,
        start_time: body.start_time, end_time: body.end_time, subject_persona_id: body.subject_persona_id,
        meeting_type_id: body.meeting_type_id, description: body.description, timezone: body.timezone,
        location_type: body.location_type, location_detail: body.location_detail, meeting_url: body.meeting_url,
        attendees: body.attendees, notes: body.notes, entity_ref: body.entity_ref, source: body.source,
      });
      return reply.code(201).send({ data: { appointment } });
    } catch (err) {
      if (err instanceof InvalidTimeRangeError) {
        return reply.code(400).send({ error: 'ValidationError', details: ['end_time must be after start_time'] });
      }
      if (err instanceof DoubleBookingError) {
        return reply.code(409).send({ error: 'DoubleBooking', details: ['the host already has an appointment overlapping this window'] });
      }
      throw err;
    }
  });

  app.get<{ Querystring: {
    tenant_id?: string; host_persona_id?: string; subject_persona_id?: string; status?: string;
    start_after?: string; start_before?: string;
  } }>(
    '/api/scheduling/appointments', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      }
      const appointments = await listAppointments(req.query.tenant_id, {
        host_persona_id: req.query.host_persona_id, subject_persona_id: req.query.subject_persona_id,
        status: req.query.status, start_after: req.query.start_after, start_before: req.query.start_before,
      });
      return reply.code(200).send({ data: { appointments } });
    },
  );

  app.get<{ Params: { appointment_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/scheduling/appointments/:appointment_id', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      }
      const appointment = await getAppointment(req.query.tenant_id, req.params.appointment_id);
      if (!appointment) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { appointment } });
    },
  );

  /* --------------------------------------------------- booking lifecycle (TK-3624) */
  // Small helper: map booking-service errors to HTTP responses uniformly.
  const sendBookingError = (reply: import('fastify').FastifyReply, err: unknown): unknown => {
    if (err instanceof AppointmentNotFoundError) return reply.code(404).send({ error: 'NotFound', details: ['appointment not found'] });
    if (err instanceof InvalidBookingTransitionError) return reply.code(409).send({ error: 'InvalidTransition', details: [(err as Error).message] });
    if (err instanceof InvalidTimeRangeError) return reply.code(400).send({ error: 'ValidationError', details: ['end_time must be after start_time'] });
    if (err instanceof DoubleBookingError) return reply.code(409).send({ error: 'DoubleBooking', details: ['the host already has an appointment overlapping this window'] });
    throw err;
  };

  app.post<{ Params: { appointment_id: string } }>(
    '/api/scheduling/appointments/:appointment_id/confirm', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string };
      if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
      try {
        const appointment = await confirmBooking(body.tenant_id, req.params.appointment_id);
        return reply.code(200).send({ data: { appointment } });
      } catch (err) { return sendBookingError(reply, err); }
    },
  );

  app.post<{ Params: { appointment_id: string } }>(
    '/api/scheduling/appointments/:appointment_id/reschedule', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string; start_time?: string; end_time?: string; timezone?: string };
      if (!body.tenant_id || !body.start_time || !body.end_time) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, start_time and end_time are required'] });
      }
      try {
        const appointment = await rescheduleBooking(body.tenant_id, req.params.appointment_id, {
          start_time: body.start_time, end_time: body.end_time, timezone: body.timezone,
        });
        return reply.code(200).send({ data: { appointment } });
      } catch (err) { return sendBookingError(reply, err); }
    },
  );

  app.post<{ Params: { appointment_id: string } }>(
    '/api/scheduling/appointments/:appointment_id/cancel', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string; reason?: string };
      if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
      try {
        const appointment = await cancelBooking(body.tenant_id, req.params.appointment_id, body.reason);
        return reply.code(200).send({ data: { appointment } });
      } catch (err) { return sendBookingError(reply, err); }
    },
  );

  // ICS invite for the appointment's current state (text/calendar attachment body).
  app.get<{ Params: { appointment_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/scheduling/appointments/:appointment_id/ics', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      try {
        const ics = await generateAppointmentIcs(req.query.tenant_id, req.params.appointment_id);
        return reply.code(200)
          .header('content-type', 'text/calendar; charset=utf-8')
          .header('content-disposition', `attachment; filename="appointment-${req.params.appointment_id}.ics"`)
          .send(ics);
      } catch (err) { return sendBookingError(reply, err); }
    },
  );

  // Booking lifecycle timeline (created/confirmed/rescheduled/cancelled/notified).
  app.get<{ Params: { appointment_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/scheduling/appointments/:appointment_id/events', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const events = await listBookingEvents(req.query.tenant_id, req.params.appointment_id);
      return reply.code(200).send({ data: { events } });
    },
  );

  /* ------------------------------------------------------ scheduling links (TK-3624) */
  app.post('/api/scheduling/scheduling-links', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as Partial<{
      tenant_id: string; host_persona_id: string; slug: string; meeting_type_id: string;
      title: string; description: string; max_days_ahead: number; min_notice_minutes: number; expires_at: string;
    }>;
    if (!body.tenant_id || !body.host_persona_id || !body.slug) {
      return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, host_persona_id and slug are required'] });
    }
    try {
      const link = await createSchedulingLink({
        tenant_id: body.tenant_id, host_persona_id: body.host_persona_id, slug: body.slug,
        meeting_type_id: body.meeting_type_id, title: body.title, description: body.description,
        max_days_ahead: body.max_days_ahead, min_notice_minutes: body.min_notice_minutes, expires_at: body.expires_at,
      });
      return reply.code(201).send({ data: { link } });
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.code(409).send({ error: 'Conflict', details: ['a scheduling link with this slug already exists'] });
      }
      throw err;
    }
  });

  app.get<{ Querystring: { tenant_id?: string } }>(
    '/api/scheduling/scheduling-links', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const links = await listSchedulingLinks(req.query.tenant_id);
      return reply.code(200).send({ data: { links } });
    },
  );

  app.get<{ Params: { link_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/scheduling/scheduling-links/:link_id', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const link = await getSchedulingLink(req.query.tenant_id, req.params.link_id);
      if (!link) return reply.code(404).send({ error: 'NotFound' });
      return reply.code(200).send({ data: { link } });
    },
  );

  /* ------------------------------------------- reminders + no-show + rebook (TK-3621) */
  // Schedule the reminder fan-out (default 24h/2h/15m) for an appointment.
  app.post<{ Params: { appointment_id: string } }>(
    '/api/scheduling/appointments/:appointment_id/reminders', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string; offsets_minutes?: number[] };
      if (!body.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id is required'] });
      try {
        const reminders = await scheduleReminders(
          body.tenant_id, req.params.appointment_id,
          Array.isArray(body.offsets_minutes) && body.offsets_minutes.length ? body.offsets_minutes : undefined,
        );
        return reply.code(201).send({ data: { reminders } });
      } catch (err) {
        return reply.code(404).send({ error: 'NotFound', details: [(err as Error).message] });
      }
    },
  );

  app.get<{ Params: { appointment_id: string }; Querystring: { tenant_id?: string } }>(
    '/api/scheduling/appointments/:appointment_id/reminders', { preHandler: requireAuth }, async (req, reply) => {
      if (!req.query.tenant_id) return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id query param required'] });
      const reminders = await listReminders(req.query.tenant_id, req.params.appointment_id);
      return reply.code(200).send({ data: { reminders } });
    },
  );

  // On-demand reminder drain (also runs on a timer when SCHEDULING_WORKER_ENABLED).
  app.post<{ Body: { batch_size?: number } }>(
    '/api/scheduling/reminders/tick', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { batch_size?: number };
      const result = await runReminderTick(body.batch_size ?? 50);
      return reply.code(200).send({ data: result });
    },
  );

  // On-demand no-show scan: mark confirmed appointments past end_time + grace as no_show.
  app.post<{ Body: { grace_minutes?: number; batch_size?: number } }>(
    '/api/scheduling/no-show/scan', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { grace_minutes?: number; batch_size?: number };
      const result = await runNoShowScan(body.grace_minutes ?? 10, body.batch_size ?? 100);
      return reply.code(200).send({ data: result });
    },
  );

  // Rescue/rebook a (no-show/cancelled) appointment into a new confirmed slot.
  app.post<{ Params: { appointment_id: string } }>(
    '/api/scheduling/appointments/:appointment_id/rebook', { preHandler: requireAuth }, async (req, reply) => {
      const body = (req.body ?? {}) as { tenant_id?: string; start_time?: string; end_time?: string; timezone?: string };
      if (!body.tenant_id || !body.start_time || !body.end_time) {
        return reply.code(400).send({ error: 'ValidationError', details: ['tenant_id, start_time and end_time are required'] });
      }
      try {
        const appointment = await rebookAppointment(body.tenant_id, req.params.appointment_id, {
          start_time: body.start_time, end_time: body.end_time, timezone: body.timezone,
        });
        return reply.code(201).send({ data: { appointment } });
      } catch (err) {
        if (err instanceof InvalidTimeRangeError) return reply.code(400).send({ error: 'ValidationError', details: ['end_time must be after start_time'] });
        if (err instanceof DoubleBookingError) return reply.code(409).send({ error: 'DoubleBooking', details: ['the host already has an appointment overlapping this window'] });
        return reply.code(404).send({ error: 'NotFound', details: [(err as Error).message] });
      }
    },
  );
}
