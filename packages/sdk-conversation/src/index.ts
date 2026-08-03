/**
 * @projexlight/sdk-conversation — public surface.
 *
 * P6B · Chat session lifecycle (started → active → handed-off → closed),
 * multi-turn memory sandboxed per P6A, AI ↔ human handoff, transcript
 * storage per tenant App Pool, streaming via sdk-ai-gateway, RAG
 * integration for grounded answers.
 */
export { migrationsDir } from './db';

// Fastify surface (P16 EP-381 / PCF-08-3). Mounted by the api-gateway via
// app.register(conversationServer.registerRoutes).
export * as server from './server';

// Compose guardrails — verdict + ORDERED reasons per channel, decided from
// caller-supplied resolver output. This SDK carries no consent or policy logic.
export {
  evaluateComposeGuardrail,
  evaluateChannelFacts,
  rankChannels,
} from './services/composeGuardrailService';
export type {
  GuardrailVerdict,
  GuardrailReasonCode,
  GuardrailReason,
  GuardrailResolver,
  GuardrailContext,
  GuardrailDecision,
  ChannelFacts,
  ChannelGuardrail,
} from './services/composeGuardrailService';

// Session lifecycle + handoff (FR-CVS-1, FR-CVS-3 / AC-3 / TK-3376).
export {
  openSession,
  getSession,
  closeSession,
  setSessionActive,
  touchSession,
  handoff,
  resumeHandoff,
} from './services/sessionService';
export type {
  OpenSessionInput,
  HandoffInput,
} from './services/sessionService';

// Message send / streaming (FR-CVS-2, FR-CVS-5, FR-CVS-6).
export {
  sendMessage,
  sendMessageStream,
  listTurns,
} from './services/messageService';
export type {
  SendMessageInput,
  SendMessageResult,
  StreamMessageResult,
  GroundingSpec,
} from './services/messageService';

// Omnichannel thread + message model (P16 EP-381 / PCF-08-1). Purely additive:
// the session/turn surface above is unchanged, so existing callers keep working.
export {
  openThread,
  getThread,
  listThreads,
  listInbox,
  recordEligibilitySnapshot,
  closeThread,
  reopenThread,
  recordMessage,
  addInternalNote,
  listThreadMessages,
  getMessage,
  updateDeliveryState,
  markThreadRead,
  claimPendingDispatch,
  assertDispatchable,
  DISPATCHABLE_CHANNELS,
} from './services/threadService';
// Reply detection + outbound linkage (P16 EP-381 / PCF-08-2).
export {
  detectAndLinkReply,
  resolveReplyParent,
  listUnmatchedInbound,
  retryUnmatched,
  parseReferenceKeys,
  confidenceOf,
} from './services/replyDetection';
export type {
  DetectReplyInput,
  ReplySignals,
  ReplyLinkResult,
  ReplyLinkMethod,
  ReplyLinkState,
  ReplyLinkConfidence,
} from './services/replyDetection';

export type {
  ConversationThread,
  ConversationMessage,
  ThreadChannel,
  MessageDirection,
  DeliveryState,
  ReadState,
  ThreadStatus,
  OpenThreadInput,
  ListThreadsInput,
  InboxFilter,
  RecordMessageInput,
  AddInternalNoteInput,
  ListMessagesInput,
} from './services/threadService';
