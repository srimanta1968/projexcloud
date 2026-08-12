export * as server from './server';
export * as types from './models/notification.model';
export { migrationsDir } from './db';
export {
  createTemplate,
  sendNotification,
  markDelivered,
  TemplateNotFoundError,
} from './services/notificationService';
export { getQuietHours, getQuietHoursBulk, setQuietHours, isInQuietHours, quietHoursState } from './services/quietHours';
// Read-only send-window pre-flight: the quiet-hours + frequency-cap verdict
// WITHOUT attempting a send (P16 EP-383 follow-on).
export { checkSendWindow, checkSendWindowBulk } from './services/sendWindow';
export type {
  SendWindowQuery,
  SendWindowVerdict,
  BulkSendWindowQuery,
  BulkSendWindowRow,
} from './services/sendWindow';
export {
  unifiedDispatch,
  makeSequenceStepSender,
  setSequenceDestinationResolver,
  setPreSendGuard,
} from './services/dispatchService';
export {
  classifyKeyword,
  processInboundSms,
  setSmsConsentHandler,
  upsertSmsSettings,
  listInboundSms,
  propagateSmsConsent,
  getSmsConsent,
  listSmsConsent,
  normalizeE164,
} from './services/smsInboundService';
export type { KeywordIntent, SmsConsentEvent } from './services/smsInboundService';
export {
  classifyDeliveryStatus,
  processDeliveryCallback,
  setDeliveryReputationHook,
  listDeliveryReceipts,
} from './services/deliveryCallbackService';
export type {
  UnifiedDispatchInput,
  UnifiedDispatchResult,
  SequenceStepLike,
  SequenceDestinationResolver,
  ResolvedDestination,
} from './services/dispatchService';
export {
  bindEmailProvider,
  rotateEmailProvider,
  revokeEmailProvider,
  listEmailProviders,
  verifyEmailProvider,
  resolveEmailSend,
  setPlatformEmailProvider,
  getPlatformEmailProvider,
  sendPlatformEmail,
} from './services/emailProviderService';
export type {
  EmailProviderBinding,
  EmailProviderKind,
  BindEmailProviderInput,
} from './services/emailProviderService';
export {
  emailValidationMode,
  assessEmailDeliverability,
  gatePlatformEmail,
  maskEmail,
} from './services/emailDeliverability';
export type {
  EmailValidationMode,
  DeliverabilityAssessment,
  DeliverabilityReason,
} from './services/emailDeliverability';
export { resolveTemplate, renderTemplate } from './services/templateEngine';
export { registerAdapter, getProvidersForChannel } from './services/providerAdapters';
export type { ProviderAdapter, SendArgs, SendResult } from './services/providerAdapters';
export { registerSesEmailAdapter, sesEmailAdapter } from './services/sesEmailAdapter';
export { registerSmtpEmailAdapter, smtpEmailAdapter } from './services/smtpEmailAdapter';
export { registerTwilioSmsAdapter, twilioSmsAdapter } from './services/twilioSmsAdapter';
export { registerApnsPushAdapter, apnsPushAdapter } from './services/apnsPushAdapter';
export { registerFcmPushAdapter, fcmPushAdapter } from './services/fcmPushAdapter';
export { registerSlackOutboundAdapter, slackOutboundAdapter } from './services/slackOutboundAdapter';

// Frequency caps + no-answer dedup window (P16 EP-383). Additive: existing sends are
// unaffected unless a caller opts in via purpose / respect_frequency_cap / dedup_key.
export {
  resolveFrequencyPolicy,
  setFrequencyPolicy,
  listFrequencyPolicies,
  reserveSend,
  releaseSend,
  getSendUsage,
  computeDedupKey,
  BUILTIN_POLICY,
} from './services/frequencyCap';
export type {
  FrequencyPolicy,
  CapDecision,
  ReserveSendInput,
  SetFrequencyPolicyInput,
} from './services/frequencyCap';
