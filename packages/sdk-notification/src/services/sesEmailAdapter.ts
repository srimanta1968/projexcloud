// Requires AWS credentials via standard AWS SDK chain (env vars, instance
// profile, IRSA). Set NOTIFICATION_FROM_EMAIL / AWS_REGION to enable boot-time
// registration.
//
// Real AWS SESv2 email adapter implementing the ProviderAdapter contract from
// providerAdapters.ts. Replaces the synthetic 'ses' stub. On AWS errors
// (Throttling / MessageRejected / InvalidParameterValue / etc.) we rethrow
// so the failover chain in sendWithFailover() can advance to the next
// registered provider for the same channel.

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { registerAdapter, type ProviderAdapter, type SendArgs, type SendResult } from './providerAdapters';

let cachedClient: SESv2Client | null = null;

function getClient(): SESv2Client {
  if (cachedClient) return cachedClient;
  const region = process.env.AWS_REGION || 'us-east-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  // If explicit keys are absent, fall through to the default AWS SDK credential
  // chain so IRSA / EC2 instance role / shared config files all work.
  cachedClient =
    accessKeyId && secretAccessKey
      ? new SESv2Client({ region, credentials: { accessKeyId, secretAccessKey } })
      : new SESv2Client({ region });
  return cachedClient;
}

export const sesEmailAdapter: ProviderAdapter = {
  provider: 'ses',
  channel: 'email',
  async send(args: SendArgs): Promise<SendResult> {
    const from = process.env.NOTIFICATION_FROM_EMAIL;
    if (!from) {
      throw new Error('sesEmailAdapter: NOTIFICATION_FROM_EMAIL is not set');
    }
    const client = getClient();
    const command = new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [args.destination] },
      Content: {
        Simple: {
          Subject: { Data: args.subject ?? 'Notification', Charset: 'UTF-8' },
          Body: { Text: { Data: args.body, Charset: 'UTF-8' } },
        },
      },
      ConfigurationSetName: process.env.SES_CONFIGURATION_SET,
    });
    try {
      const response = await client.send(command);
      return {
        provider: 'ses',
        provider_message_id: response.MessageId ?? `ses_${Date.now().toString(36)}`,
        delivered_status: 'sent',
      };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      // Rethrow with the AWS-supplied message so the failover layer in
      // providerAdapters.sendWithFailover() can capture it in AggregateError
      // and fall through to the next configured provider.
      throw new Error(`sesEmailAdapter ${e.name ?? 'AwsError'}: ${e.message ?? String(err)}`);
    }
  },
};

/**
 * Registers the real SESv2 adapter at boot. Only registers when
 * NOTIFICATION_FROM_EMAIL is set — otherwise we'd register an adapter that
 * is guaranteed to throw on every send() and would shadow the synthetic
 * stub used in dev/test.
 */
export function registerSesEmailAdapter(): boolean {
  if (!process.env.NOTIFICATION_FROM_EMAIL) return false;
  registerAdapter(sesEmailAdapter);
  return true;
}
