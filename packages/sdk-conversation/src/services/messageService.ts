import { randomUUID } from 'crypto';
import { dataService } from '@projexlight/db-runtime';
import { appendAuditEntry } from '@projexlight/sdk-audit';
import { complete, stream } from '@projexlight/sdk-ai-gateway';
import type {
  ConversationTurn,
  ConversationAuthorKind,
  AgentContext,
  ChatMessage,
  CompletionResponse,
  StreamChunk,
} from '@projexlight/contracts';
import { setSessionActive, touchSession } from './sessionService';

/**
 * Conversation message I/O (FR-CVS-2, FR-CVS-5, FR-CVS-6).
 *
 * sendMessage() composes:
 *   1. user turn persisted with vault-wrapped body
 *   2. (optional) RAG retrieval — caller passes `grounding` { corpus_id,
 *      query, top_k }; we record the rag_retrieval_id on the assistant turn
 *   3. session-history reconstruction (last N turns) — bounded so the
 *      provider context stays in budget
 *   4. sdk-ai-gateway.complete() (or .stream() when opts.stream = true)
 *   5. assistant turn persisted with rag_retrieval_id, tokens, model_used
 *   6. session.last_active_at touched
 *
 * Vault-wrap is intentionally minimal in v1 — we store the plaintext bytes
 * in message_envelope. Production callers wire sdk-vault into a per-tenant
 * wrap helper; this stub keeps the surface stable.
 */

const CONVERSATION_AUDIT_POOL = process.env.CONVERSATION_AUDIT_POOL || 'admin-default';
const HISTORY_MAX_TURNS = parseInt(process.env.CONVERSATION_HISTORY_MAX_TURNS ?? '20', 10);

export interface GroundingSpec {
  /** Optional caller-provided RAG retrieval id (when retrieve was already run upstream). */
  rag_retrieval_id?: string;
}

export interface SendMessageInput {
  session_id: string;
  author_kind: ConversationAuthorKind;
  author_id: string;
  message_text: string;
  /** When provided, the assistant turn records this id for derivation chain. */
  grounding?: GroundingSpec;
  /** When true, returns the streaming iterator instead of the final turn. */
  stream?: boolean;
  /** Provider/model hint — falls back to gateway default routing. */
  model?: string;
  /** Required AgentContext for sdk-ai-gateway (tenant_id + trace_id at minimum). */
  agent_ctx: AgentContext;
}

interface TurnRow {
  turn_id: string;
  session_id: string;
  seq: number;
  author_kind: string;
  author_id: string;
  tokens: number;
  model_used: string | null;
  rag_retrieval_id: string | null;
  occurred_at: Date;
}

interface SessionRow {
  session_id: string;
  tenant_id: string;
  vector_namespace: string;
  status: string;
}

function turnRowToContract(r: TurnRow): ConversationTurn {
  return {
    turn_id: r.turn_id,
    session_id: r.session_id,
    seq: r.seq,
    author_kind: r.author_kind as ConversationAuthorKind,
    author_id: r.author_id,
    tokens: r.tokens,
    model_used: r.model_used,
    rag_retrieval_id: r.rag_retrieval_id,
    occurred_at: r.occurred_at.toISOString(),
  };
}

async function loadSessionForWrite(session_id: string): Promise<SessionRow> {
  const row = await dataService.one<SessionRow>(
    `SELECT session_id, tenant_id::text, vector_namespace, status
       FROM conversation.session WHERE session_id = $1`,
    [session_id],
  );
  if (!row) throw new Error(`[sdk-conversation] session ${session_id} not found`);
  if (row.status === 'closed') {
    throw new Error(`[sdk-conversation] session ${session_id} is closed`);
  }
  return row;
}

/**
 * Returns the next monotonic seq number for the session. Cheaper than a
 * sequence object because session-level INSERT load is bounded and the
 * lock is row-scoped via SELECT MAX in the same transaction.
 */
async function nextSeq(
  q: <R extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: R[] }>,
  session_id: string,
): Promise<number> {
  const r = await q<{ next_seq: number }>(
    `SELECT COALESCE(MAX(seq), -1) + 1 AS next_seq
       FROM conversation.turn WHERE session_id = $1`,
    [session_id],
  );
  return r.rows[0]?.next_seq ?? 0;
}

async function loadHistory(session_id: string, max: number): Promise<ChatMessage[]> {
  const rows = await dataService.rows<{ author_kind: string; message_envelope: Buffer }>(
    `SELECT author_kind, message_envelope
       FROM conversation.turn
      WHERE session_id = $1
      ORDER BY seq DESC
      LIMIT $2`,
    [session_id, max],
  );
  return rows
    .reverse()
    .map((r) => ({
      role:
        r.author_kind === 'user'
          ? 'user'
          : r.author_kind === 'agent' || r.author_kind === 'human-agent'
            ? 'assistant'
            : 'system',
      content: r.message_envelope.toString('utf8'),
    }));
}

async function persistUserTurn(input: {
  session_id: string;
  author_kind: ConversationAuthorKind;
  author_id: string;
  message_text: string;
}): Promise<ConversationTurn> {
  const turnId = randomUUID();
  let result!: TurnRow;
  await dataService.tx(async (q) => {
    const seq = await nextSeq(q, input.session_id);
    const r = await q<TurnRow>(
      `INSERT INTO conversation.turn
         (turn_id, session_id, seq, author_kind, author_id,
          message_envelope, tokens, model_used, rag_retrieval_id)
       VALUES ($1, $2, $3, $4, $5::uuid, $6, $7, NULL, NULL)
       RETURNING turn_id, session_id, seq, author_kind, author_id::text,
                 tokens, model_used, rag_retrieval_id, occurred_at`,
      [
        turnId,
        input.session_id,
        seq,
        input.author_kind,
        input.author_id,
        Buffer.from(input.message_text, 'utf8'),
        Math.ceil(input.message_text.length / 4), // rough token estimate
      ],
    );
    result = r.rows[0];
  });
  return turnRowToContract(result);
}

async function persistAssistantTurn(input: {
  session_id: string;
  author_id: string;
  output: string;
  tokens: number;
  model_used: string | null;
  rag_retrieval_id: string | null;
}): Promise<ConversationTurn> {
  const turnId = randomUUID();
  let result!: TurnRow;
  await dataService.tx(async (q) => {
    const seq = await nextSeq(q, input.session_id);
    const r = await q<TurnRow>(
      `INSERT INTO conversation.turn
         (turn_id, session_id, seq, author_kind, author_id,
          message_envelope, tokens, model_used, rag_retrieval_id)
       VALUES ($1, $2, $3, 'agent', $4::uuid, $5, $6, $7, $8)
       RETURNING turn_id, session_id, seq, author_kind, author_id::text,
                 tokens, model_used, rag_retrieval_id, occurred_at`,
      [
        turnId,
        input.session_id,
        seq,
        input.author_id,
        Buffer.from(input.output, 'utf8'),
        input.tokens,
        input.model_used,
        input.rag_retrieval_id,
      ],
    );
    result = r.rows[0];
  });
  return turnRowToContract(result);
}

export interface SendMessageResult {
  user_turn: ConversationTurn;
  assistant_turn: ConversationTurn;
  completion: CompletionResponse;
}

/**
 * Non-streaming sendMessage. Persists user turn, calls gateway, persists
 * assistant turn, touches session activity. Returns both turns + the raw
 * completion so callers can inspect tokens/cost without re-querying.
 */
export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const sess = await loadSessionForWrite(input.session_id);
  await setSessionActive(input.session_id);

  const userTurn = await persistUserTurn({
    session_id: input.session_id,
    author_kind: input.author_kind,
    author_id: input.author_id,
    message_text: input.message_text,
  });

  const history = await loadHistory(input.session_id, HISTORY_MAX_TURNS);
  const completion = await complete(
    {
      model: input.model ?? 'claude-opus-4-6',
      prompt: history,
    },
    input.agent_ctx,
  );

  const assistantTurn = await persistAssistantTurn({
    session_id: input.session_id,
    author_id: input.agent_ctx.agent_id ?? 'platform-agent',
    output: completion.output,
    tokens: completion.tokens_out,
    model_used: `${completion.provider_id}:${completion.model}`,
    rag_retrieval_id: input.grounding?.rag_retrieval_id ?? null,
  });

  await touchSession(input.session_id);

  try {
    await appendAuditEntry({
      pool_index: CONVERSATION_AUDIT_POOL,
      event_type: 'conversation.turn.recorded.v1',
      actor_kind: 'service',
      actor_id: 'sdk-conversation',
      tenant_id: sess.tenant_id,
      subject_kind: 'conversation.session',
      subject_id: input.session_id,
      retention_class: 'regulated',
      payload: {
        user_turn_id: userTurn.turn_id,
        assistant_turn_id: assistantTurn.turn_id,
        completion_id: completion.completion_id,
        tokens_in: completion.tokens_in,
        tokens_out: completion.tokens_out,
        trace_id: input.agent_ctx.trace_id,
      },
    });
  } catch (err) {
    console.warn('[sdk-conversation] turn audit failed (non-fatal):', (err as Error).message);
  }

  return { user_turn: userTurn, assistant_turn: assistantTurn, completion };
}

export interface StreamMessageResult {
  user_turn: ConversationTurn;
  chunks: AsyncIterable<StreamChunk>;
  /** Resolves after the stream closes with the persisted assistant turn. */
  done: Promise<ConversationTurn>;
}

/**
 * Streaming variant. The user turn lands immediately; chunks are yielded
 * as the provider produces them; the final assistant turn is persisted on
 * stream close. The `done` promise resolves with the turn so callers can
 * await both the stream and the final persistence.
 */
export async function sendMessageStream(input: SendMessageInput): Promise<StreamMessageResult> {
  const sess = await loadSessionForWrite(input.session_id);
  await setSessionActive(input.session_id);

  const userTurn = await persistUserTurn({
    session_id: input.session_id,
    author_kind: input.author_kind,
    author_id: input.author_id,
    message_text: input.message_text,
  });

  const history = await loadHistory(input.session_id, HISTORY_MAX_TURNS);

  let accumOutput = '';
  let lastTokens = 0;
  let lastFinishReason: CompletionResponse['finish_reason'] | undefined;

  let resolveDone!: (t: ConversationTurn) => void;
  let rejectDone!: (e: unknown) => void;
  const done = new Promise<ConversationTurn>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  // Generator that tees the stream while accumulating for persistence.
  async function* tee(): AsyncIterable<StreamChunk> {
    try {
      for await (const chunk of stream(
        { model: input.model ?? 'claude-opus-4-6', prompt: history, stream: true },
        input.agent_ctx,
      )) {
        accumOutput += chunk.delta;
        if (chunk.tokens_so_far != null) lastTokens = chunk.tokens_so_far;
        if (chunk.finish_reason) lastFinishReason = chunk.finish_reason;
        yield chunk;
      }

      const assistantTurn = await persistAssistantTurn({
        session_id: input.session_id,
        author_id: input.agent_ctx.agent_id ?? 'platform-agent',
        output: accumOutput,
        tokens: lastTokens,
        model_used: input.model ?? null,
        rag_retrieval_id: input.grounding?.rag_retrieval_id ?? null,
      });

      await touchSession(input.session_id);

      try {
        await appendAuditEntry({
          pool_index: CONVERSATION_AUDIT_POOL,
          event_type: 'conversation.turn.recorded.v1',
          actor_kind: 'service',
          actor_id: 'sdk-conversation',
          tenant_id: sess.tenant_id,
          subject_kind: 'conversation.session',
          subject_id: input.session_id,
          retention_class: 'regulated',
          payload: {
            user_turn_id: userTurn.turn_id,
            assistant_turn_id: assistantTurn.turn_id,
            tokens_out: lastTokens,
            finish_reason: lastFinishReason,
            trace_id: input.agent_ctx.trace_id,
            streamed: true,
          },
        });
      } catch (err) {
        console.warn('[sdk-conversation] stream turn audit failed (non-fatal):', (err as Error).message);
      }

      resolveDone(assistantTurn);
    } catch (err) {
      rejectDone(err);
      throw err;
    }
  }

  return { user_turn: userTurn, chunks: tee(), done };
}

export async function listTurns(session_id: string, limit = 100): Promise<ConversationTurn[]> {
  const rows = await dataService.rows<TurnRow>(
    `SELECT turn_id, session_id, seq, author_kind, author_id::text,
            tokens, model_used, rag_retrieval_id, occurred_at
       FROM conversation.turn
      WHERE session_id = $1
      ORDER BY seq
      LIMIT $2`,
    [session_id, limit],
  );
  return rows.map(turnRowToContract);
}
