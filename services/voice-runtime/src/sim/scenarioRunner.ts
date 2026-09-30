import type { ChatMessage } from '@projexlight/contracts';
import type { Bootstrap, ControlPlane } from '../controlPlane';
import { log } from '../log';
import { realProviders, VoiceSession, type SessionProviders } from '../pipeline/voiceSession';
import type { SessionStore, TurnRecord } from '../session/sessionStore';
import { TRANSFER_TOOL } from '../call/transfer';
import { LoopbackMedia, type LoopbackOptions } from './loopback';
import { scriptedAgentLlm, type ScriptTurn } from './scriptedAgent';

/**
 * Plays one evaluation scenario (VA·E10 · TK-4518): a VoiceSession — the same pipeline a real
 * call runs — over loopback media, with a simulated caller that either follows a script or is
 * played by an LLM (persona + goal). Returns what happened and which expectations held.
 */

export interface Scenario {
  name: string;
  caller?: { persona?: string; goal?: string };
  turns?: (ScriptTurn & { interrupt?: boolean })[];
  max_turns?: number;
  expect?: {
    tools_called?: string[];
    tools_not_called?: string[];
    transfer?: boolean;
    says_any?: string[];
    says_none?: string[];
  };
}

export interface Check { name: string; passed: boolean; detail?: string }

export interface ScenarioResult {
  name: string;
  call_id: string;
  passed: boolean;
  checks: Check[];
  error: string | null;
  turns: number;
  tools: { name: string; ok: boolean; error: string | null; ms: number }[];
  transfer_requested: boolean;
  ttft_ms: number[];
  barge_in_stop_ms: number[];
  transcript: { speaker: string; text: string; interrupted: boolean }[];
  duration_ms: number;
}

export interface RunScenarioInput {
  boot: Bootstrap;
  scenario: Scenario;
  mode: 'sandbox' | 'evaluation';
  controlPlane: ControlPlane;
  store: SessionStore;
  /** Tests override the pacing; the defaults are speech-like. */
  loopback?: LoopbackOptions;
  /** How long to wait for the agent to finish one reply. */
  replyTimeoutMs?: number;
  /** How long the agent talks before an `interrupt` line cuts in (default 1000 ms). */
  interruptAfterMs?: number;
  /** Tests stand in for the tenant's real LLM (evaluation mode). */
  agentLlm?: SessionProviders['llm'];
  /** Tests inject the LLM that plays the caller. */
  callerLlm?: (messages: ChatMessage[]) => Promise<string>;
}

const FALLBACK_PREFIXES = ["Sorry, I'm having trouble on my end", "Sorry, I couldn't get that information right now"];
const MAX_BARGE_IN_STOP_MS = Number(process.env.VOICE_EVAL_MAX_BARGE_IN_MS ?? 250);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms); })]);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function until(cond: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** The LLM that plays the caller in evaluation mode: the tenant's fast model, with its key. */
function tenantCallerLlm(boot: Bootstrap, providers: SessionProviders): (messages: ChatMessage[]) => Promise<string> {
  const fast = boot.stack.layers.llm_fast;
  return async (messages) => {
    const r = await providers.llm(fast.provider).complete(
      { model: fast.model ?? '', prompt: messages, max_tokens: 80, temperature: 0.7 },
      Buffer.from(fast.primary.key),
    );
    return r.output.trim();
  };
}

export async function runScenario(input: RunScenarioInput): Promise<{ result: ScenarioResult; records: TurnRecord[] }> {
  const { boot, scenario, mode } = input;
  const started = Date.now();
  const replyTimeout = input.replyTimeoutMs ?? 45_000;
  const media = new LoopbackMedia(boot.call.call_id, input.loopback);
  const providers: SessionProviders = {
    stt: () => media.sttProvider,
    tts: () => media.ttsProvider,
    // Sandbox: a scripted agent, no keys. Evaluation: the tenant's real models and keys.
    llm: mode === 'sandbox' ? (() => { const a = scriptedAgentLlm(scenario.turns ?? []); return () => a; })() : (input.agentLlm ?? realProviders.llm),
  };
  const bargeIns: number[] = [];
  let transferRequested = false;
  // Transfers are recorded, never executed: a simulated call must not create handoffs or dial.
  const cp = Object.create(input.controlPlane) as ControlPlane;
  cp.transfer = async () => {
    transferRequested = true;
    return { handoff_id: 'simulated', mode: 'callback', target_number: '' };
  };

  const session = input.store.open(boot, media.roomName);
  const abort = new AbortController();
  const vs = new VoiceSession(media, session, abort.signal, input.store, cp, {
    providers,
    observer: { onBargeIn: (ms) => bargeIns.push(ms) },
  });
  let error: string | null = null;
  const running = vs.run().catch((err: Error) => { error = error ?? `session failed: ${err.message}`; });
  const callerTurns = (): number => session.turns.filter((t) => t.speaker === 'caller').length;

  const sayAndWait = async (text: string, interrupt: boolean): Promise<void> => {
    if (interrupt) {
      // Talk over the agent: wait until it is audibly answering the previous line.
      await until(() => media.agentSpeaking, replyTimeout, 'the agent to start answering (for the interruption)');
      // Mid-sentence, like a person: let the agent get a few words out first.
      const cutIn = Date.now() + (input.interruptAfterMs ?? 1000);
      // agentBusy spans the whole reply; the sink alone reads idle between two clauses.
      while (Date.now() < cutIn && vs.agentBusy) await sleep(20);
    } else {
      await within(vs.settled(), replyTimeout, 'the agent to finish its reply');
    }
    const before = callerTurns();
    await media.say(text);
    await until(() => callerTurns() > before, 10_000, 'the caller line to be taken as a turn');
  };

  try {
    await within(media.ready, 15_000, 'the session to start listening');
    await within(vs.settled(), replyTimeout, 'the opening (disclosure and greeting)');
    if (scenario.turns) {
      for (const t of scenario.turns) await sayAndWait(t.say, t.interrupt === true);
    } else {
      const caller = input.callerLlm ?? tenantCallerLlm(boot, providers);
      const persona = scenario.caller?.persona ?? 'a caller';
      const goal = scenario.caller?.goal ?? 'get help';
      for (let i = 0; i < (scenario.max_turns ?? 6); i++) {
        await within(vs.settled(), replyTimeout, 'the agent to finish its reply');
        const convo: ChatMessage[] = [
          {
            role: 'system',
            content: `You are role-playing a person on a phone call with a business's AI assistant. You are ${persona}. Your goal: ${goal}. `
              + 'Say one short, natural sentence per turn, like a real caller. When your goal is met or the call is over, reply with exactly [END].',
          },
          ...session.turns.filter((t) => t.text).map((t): ChatMessage => ({ role: t.speaker === 'caller' ? 'assistant' : 'user', content: t.text })),
        ];
        const line = await within(caller(convo), 20_000, 'the simulated caller');
        if (!line || line.includes('[END]')) break;
        await sayAndWait(line.slice(0, 300), false);
      }
    }
    await within(vs.settled(), replyTimeout, 'the agent to finish its last reply');
  } catch (err) {
    error = error ?? (err as Error).message;
  } finally {
    media.hangUp();
    abort.abort();
    await within(running, 10_000, 'the session to close').catch(() => undefined);
    input.store.close(session.callId);
  }

  const turns = session.turns;
  const tools = turns.flatMap((t) => (t.tool_calls ?? []).map((c) => ({ name: c.name, ok: c.ok, error: c.error, ms: c.ms })));
  const result: ScenarioResult = {
    name: scenario.name,
    call_id: boot.call.call_id,
    passed: false,
    checks: [],
    error,
    turns: turns.length,
    tools,
    transfer_requested: transferRequested || tools.some((t) => t.name === TRANSFER_TOOL),
    ttft_ms: turns.map((t) => t.ttft_ms).filter((v): v is number => typeof v === 'number'),
    barge_in_stop_ms: bargeIns,
    transcript: turns.map((t) => ({ speaker: t.speaker, text: t.text, interrupted: t.interrupted })),
    duration_ms: Date.now() - started,
  };
  result.checks = checkExpectations(scenario, turns, result);
  result.passed = error === null && result.checks.every((c) => c.passed);
  if (!result.passed) log.info('eval scenario failed', { callId: boot.call.call_id, scenario: scenario.name, error, failed: result.checks.filter((c) => !c.passed).map((c) => c.name) });
  return { result, records: turns };
}

/** Which expectations held. Exported for the unit test. */
export function checkExpectations(scenario: Scenario, turns: TurnRecord[], r: Pick<ScenarioResult, 'tools' | 'transfer_requested' | 'barge_in_stop_ms'>): Check[] {
  const checks: Check[] = [];
  const agentText = turns.filter((t) => t.speaker === 'agent').map((t) => t.text).join(' ').toLowerCase();
  // Every caller line got a real answer (not the "having trouble" line), unless it was cut off.
  const unanswered = turns.filter((t, i) => t.speaker === 'caller' && !turns.slice(i + 1).some((a) => a.speaker === 'agent' && a.text && !FALLBACK_PREFIXES.some((f) => a.text.startsWith(f))));
  checks.push({ name: 'answered', passed: unanswered.length === 0, detail: unanswered.length ? `${unanswered.length} caller line(s) got no real answer` : undefined });
  const failedTools = r.tools.filter((t) => !t.ok && t.name !== TRANSFER_TOOL);
  checks.push({ name: 'tools_ok', passed: failedTools.length === 0, detail: failedTools.length ? failedTools.map((t) => `${t.name}: ${t.error}`).join('; ') : undefined });
  const okNames = new Set(r.tools.filter((t) => t.ok).map((t) => t.name));
  const e = scenario.expect ?? {};
  for (const name of e.tools_called ?? []) checks.push({ name: `tool_called:${name}`, passed: okNames.has(name) || (name === TRANSFER_TOOL && r.transfer_requested) });
  for (const name of e.tools_not_called ?? []) checks.push({ name: `tool_not_called:${name}`, passed: !r.tools.some((t) => t.name === name) });
  if (e.transfer !== undefined) checks.push({ name: 'transfer', passed: r.transfer_requested === e.transfer });
  if (e.says_any?.length) checks.push({ name: 'says_any', passed: e.says_any.some((p) => agentText.includes(p.toLowerCase())) });
  for (const p of e.says_none ?? []) checks.push({ name: `says_none:${p}`, passed: !agentText.includes(p.toLowerCase()) });
  if (scenario.turns?.some((t) => t.interrupt)) {
    const worst = r.barge_in_stop_ms.length ? Math.max(...r.barge_in_stop_ms) : null;
    checks.push({
      name: 'barge_in',
      passed: worst !== null && worst <= MAX_BARGE_IN_STOP_MS,
      detail: worst === null ? 'the agent never stopped for the interruption' : `stopped in ${worst} ms (limit ${MAX_BARGE_IN_STOP_MS})`,
    });
  }
  return checks;
}
