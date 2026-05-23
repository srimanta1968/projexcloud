import type {
  CreateTemplateInput,
  NotificationChannel,
  QuietHoursWindow,
  SendNotificationInput,
  SetQuietHoursInput,
} from '../models/notification.model';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const VALID_CHANNELS: NotificationChannel[] = ['email', 'sms', 'whatsapp', 'push', 'slack'];

function asString(v: unknown): string { return typeof v === 'string' ? v.trim() : ''; }

export function validateCreateTemplate(body: unknown): ValidationResult<CreateTemplateInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const code = asString(b.code);
  const channel = asString(b.channel) as NotificationChannel;
  const locale_bundles = (b.locale_bundles && typeof b.locale_bundles === 'object')
    ? (b.locale_bundles as Record<string, Record<string, string>>)
    : null;

  if (!code) errors.push('code is required');
  if (!VALID_CHANNELS.includes(channel)) {
    errors.push(`channel must be one of ${VALID_CHANNELS.join(', ')}`);
  }
  if (!locale_bundles || Object.keys(locale_bundles).length === 0) {
    errors.push('locale_bundles is required and must include at least one locale');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      code,
      channel,
      locale_bundles: locale_bundles!,
      tenant_id: typeof b.tenant_id === 'string' ? b.tenant_id : undefined,
      required_consent_purpose: typeof b.required_consent_purpose === 'string'
        ? b.required_consent_purpose : undefined,
      version: typeof b.version === 'string' ? b.version : undefined,
    },
  };
}

export function validateSendNotification(body: unknown): ValidationResult<SendNotificationInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const tenant_id = asString(b.tenant_id);
  const template_code = asString(b.template_code);
  const person_id = asString(b.person_id);
  const channel = asString(b.channel) as NotificationChannel;
  const destination = asString(b.destination);

  if (!tenant_id) errors.push('tenant_id is required');
  if (!template_code) errors.push('template_code is required');
  if (!person_id) errors.push('person_id is required');
  if (!VALID_CHANNELS.includes(channel)) {
    errors.push(`channel must be one of ${VALID_CHANNELS.join(', ')}`);
  }
  if (!destination) errors.push('destination is required');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      tenant_id,
      template_code,
      person_id,
      channel,
      destination,
      app_identity_id: typeof b.app_identity_id === 'string' ? b.app_identity_id : undefined,
      payload: (b.payload && typeof b.payload === 'object') ? (b.payload as Record<string, unknown>) : undefined,
      locale: typeof b.locale === 'string' ? b.locale : undefined,
      scheduled_at: typeof b.scheduled_at === 'string' ? b.scheduled_at : undefined,
      enforce_consent: typeof b.enforce_consent === 'boolean' ? b.enforce_consent : undefined,
      honor_quiet_hours: typeof b.honor_quiet_hours === 'boolean' ? b.honor_quiet_hours : undefined,
    },
  };
}

function isValidWindow(w: unknown): w is QuietHoursWindow {
  if (!w || typeof w !== 'object') return false;
  const ww = w as Record<string, unknown>;
  return (
    typeof ww.dow === 'number' && ww.dow >= 0 && ww.dow <= 6 &&
    typeof ww.start === 'string' && /^\d{2}:\d{2}$/.test(ww.start) &&
    typeof ww.end === 'string' && /^\d{2}:\d{2}$/.test(ww.end) &&
    typeof ww.tz === 'string' && ww.tz.length > 0
  );
}

export function validateSetQuietHours(body: unknown): ValidationResult<SetQuietHoursInput> {
  if (!body || typeof body !== 'object') return { ok: false, errors: ['body must be an object'] };
  const b = body as Record<string, unknown>;
  const errors: string[] = [];

  const persona_id = asString(b.persona_id);
  const windows = Array.isArray(b.windows) ? b.windows : null;

  if (!persona_id) errors.push('persona_id is required');
  if (!windows) errors.push('windows must be an array');
  else if (!windows.every(isValidWindow)) errors.push('each window needs {dow:0-6, start:HH:MM, end:HH:MM, tz}');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      persona_id,
      windows: windows as QuietHoursWindow[],
      dnd: typeof b.dnd === 'boolean' ? b.dnd : undefined,
    },
  };
}
