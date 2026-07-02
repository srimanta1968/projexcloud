// Real SMTP email adapter implementing the ProviderAdapter contract from
// providerAdapters.ts. Sends via any SMTP server (Zoho, Gmail, SES-SMTP, a
// tenant's own relay) using nodemailer. Platform-default configuration comes
// from env (SMTP_HOST / SMTP_PORT / SMTP_SECURE / SMTP_USER / SMTP_PASSWORD /
// FROM_EMAIL / FROM_NAME). On transport errors we rethrow so sendWithFailover()
// can advance to the next registered provider for the email channel.
//
// Per-tenant BYO SMTP (from notification.tenant_provider_credential) is delivered
// by the tenant-first send resolver (separate task); this adapter is the
// platform-default SMTP sender + the base used to build per-tenant transports.

import nodemailer, { type Transporter } from 'nodemailer';
import { registerAdapter, type ProviderAdapter, type SendArgs, type SendResult } from './providerAdapters';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  fromName?: string;
}

let cachedTransport: Transporter | null = null;

function envConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const from = process.env.FROM_EMAIL || process.env.NOTIFICATION_FROM_EMAIL;
  if (!host || !from) return null;
  return {
    host,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASSWORD,
    from,
    fromName: process.env.FROM_NAME,
  };
}

/** Builds a nodemailer transport from an explicit config (per-tenant or platform). */
export function buildSmtpTransport(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

/** Sends one email through the given transport + config. Shared by platform + per-tenant paths. */
export async function sendViaSmtp(
  transport: Transporter,
  cfg: SmtpConfig,
  args: SendArgs,
): Promise<SendResult> {
  const info = await transport.sendMail({
    from: cfg.fromName ? `"${cfg.fromName}" <${cfg.from}>` : cfg.from,
    to: args.destination,
    subject: args.subject ?? 'Notification',
    text: args.body,
  });
  return {
    provider: 'smtp',
    provider_message_id: info.messageId ?? `smtp_${Date.now().toString(36)}`,
    delivered_status: 'sent',
  };
}

export const smtpEmailAdapter: ProviderAdapter = {
  provider: 'smtp',
  channel: 'email',
  async send(args: SendArgs): Promise<SendResult> {
    const cfg = envConfig();
    if (!cfg) throw new Error('smtpEmailAdapter: SMTP_HOST / FROM_EMAIL not set');
    if (!cachedTransport) cachedTransport = buildSmtpTransport(cfg);
    try {
      return await sendViaSmtp(cachedTransport, cfg, args);
    } catch (err) {
      const e = err as { name?: string; message?: string };
      throw new Error(`smtpEmailAdapter ${e.name ?? 'SmtpError'}: ${e.message ?? String(err)}`);
    }
  },
};

/**
 * Registers the SMTP adapter at boot. Only registers when SMTP_HOST is set,
 * otherwise the synthetic stub / other providers remain in place.
 */
export function registerSmtpEmailAdapter(): boolean {
  if (!process.env.SMTP_HOST) return false;
  registerAdapter(smtpEmailAdapter);
  return true;
}
