/**
 * TypeScript model mirroring notification.* tables per P4-Operational-Billing-DataModel §5.
 */

export type NotificationChannel = 'email' | 'sms' | 'whatsapp' | 'push' | 'slack';
export type NotificationProvider =
  | 'twilio'
  | 'ses'
  | 'smtp'
  | 'sendgrid'
  | 'whatsapp-bsp'
  | 'apns'
  | 'fcm'
  | 'slack-outbound';
export type MessageStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'bounced'
  | 'suppressed';
export type TemplateStatus = 'draft' | 'active' | 'deprecated' | 'retired';

export interface QuietHoursWindow {
  dow: number; // 0=Sun..6=Sat
  start: string; // 'HH:MM'
  end: string; // 'HH:MM'
  tz: string; // 'America/Los_Angeles'
}

export interface TemplateRecord {
  template_id: string;
  tenant_id: string | null;
  code: string;
  channel: NotificationChannel;
  locale_bundles: Record<string, Record<string, string>>;
  required_consent_purpose: string | null;
  version: string;
  status: TemplateStatus;
  created_at: Date;
}

export interface MessageRecord {
  message_id: string;
  tenant_id: string;
  template_id: string;
  person_id: string;
  app_identity_id: string | null;
  channel: NotificationChannel;
  provider: NotificationProvider;
  destination_envelope: Buffer;
  payload: Record<string, unknown>;
  status: MessageStatus;
  scheduled_at: Date | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  consent_check_ref: string | null;
  provider_message_id: string | null;
  suppression_reason: string | null;
  created_at: Date;
}

export interface QuietHoursRecord {
  persona_id: string;
  windows: QuietHoursWindow[];
  dnd: boolean;
  updated_at: Date;
}

export interface CreateTemplateInput {
  tenant_id?: string;
  code: string;
  channel: NotificationChannel;
  locale_bundles: Record<string, Record<string, string>>;
  required_consent_purpose?: string;
  version?: string;
}

export interface SendNotificationInput {
  tenant_id: string;
  template_code: string;
  person_id: string;
  app_identity_id?: string;
  channel: NotificationChannel;
  destination: string; // raw address (email, phone, slack user/channel) — vaulted before persist
  payload?: Record<string, unknown>;
  locale?: string;
  scheduled_at?: string;
  /** Override consent-check; default true. */
  enforce_consent?: boolean;
  /** Override quiet-hours; default true. */
  honor_quiet_hours?: boolean;
  /** Jurisdiction code (ISO-3166 + region, e.g. "US-CA", "DE-BE") for the
   *  consent receipt. Resolved from the tenant's residency profile when
   *  omitted; falls back to `DEFAULT_JURISDICTION` env (last resort). */
  jurisdiction?: string;
}

export interface SendNotificationResult {
  message: MessageRecord;
  status: MessageStatus;
  suppression_reason: string | null;
  rendered_body: string;
}

export interface SetQuietHoursInput {
  persona_id: string;
  windows: QuietHoursWindow[];
  dnd?: boolean;
}
