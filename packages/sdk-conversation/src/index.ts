/**
 * @projexlight/sdk-conversation — public surface.
 *
 * P6B · Chat session lifecycle (started → active → handed-off → closed),
 * multi-turn memory sandboxed per P6A, AI ↔ human handoff, transcript
 * storage per tenant App Pool, streaming via sdk-ai-gateway, RAG
 * integration for grounded answers.
 */
export { migrationsDir } from './db';

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
