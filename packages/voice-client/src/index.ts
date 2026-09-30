/**
 * @projexlight/voice-client (VA·E8 · TK-4510) — what a consumer app (LeadFlow, projex_crm)
 * uses to talk to the ProjexCloud AI voice SDK: typed call / test-session / calling-window /
 * capacity methods over the gateway HTTP API, verification of signed voice webhooks and of
 * the signed requests the voice runtime makes to app-registered tools.
 * No runtime dependencies (Node >= 18: global fetch + crypto).
 */
export { VoiceClient, VoiceClientError } from './client';
export type { VoiceClientOptions } from './client';
export { verifyWebhook } from './webhook';
export type { VerifyWebhookInput, WebhookVerification, WebhookRejectReason } from './webhook';
export { verifyToolRequest } from './toolRequest';
export type { VerifyToolRequestInput, ToolRequestVerification, ToolRequestRejectReason, ToolRequestBody } from './toolRequest';
export type * from './types';
