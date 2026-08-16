import { Resolver } from 'node:dns/promises';
import { createConnection, type Socket } from 'node:net';
import { randomBytes } from 'node:crypto';
import {
  isDisposableDomain, isPlaceholderAddress, isReservedDomain, isRoleAddress,
  parseAddress, suggestDomain,
} from './addressSyntax';

/**
 * Does this address exist, and can anything deliver to it?
 *
 * WHY THIS LIVES IN sdk-deliverability. Deliverability is this SDK's subject —
 * suppression, reputation, opt-out — and "can this address receive mail at all"
 * is the same question asked one step earlier. sdk-notification consulted its
 * own private copy before (services/emailDeliverability.ts), which meant the
 * platform-email path had a check and every TENANT send had none. Both now ask
 * this, so there is one answer rather than two.
 *
 * FOUR STAGES, EACH CHEAPER THAN THE NEXT AND EACH ABLE TO END IT:
 *
 *   1. SYNTAX — a parser, not a pattern (addressSyntax.ts). No network.
 *   2. POLICY — reserved, placeholder, disposable, role, likely typo. No network.
 *   3. MX — does the domain publish a mail exchanger, or resolve at all? One
 *      DNS query, cached per domain. This is the stage worth relying on.
 *   4. MAILBOX — an SMTP RCPT probe. OFF by default; see probeMailbox().
 *
 * FOUR VERDICTS, NOT A BOOLEAN, and that is the substantive change from the
 * guard this replaces. `{ deliverable: false }` collapsed two different facts
 * into one: "this domain cannot receive mail" and "our resolver did not answer
 * just now". The old code returned `no-mx` for both, so in strict mode a DNS
 * blip SUPPRESSED real mail to real customers. `unknown` is a separate verdict
 * here and never blocks anything.
 *
 * NOTHING THROWS. A verification failure must never fail the send it was
 * advising, let alone the registration behind it.
 *
 * WHAT IT CANNOT DO, stated plainly: without stage 4 no specific mailbox is
 * confirmed to exist, and WITH stage 4 it still is not for the large providers
 * — Gmail, Outlook and every catch-all answer 250 to each RCPT and bounce
 * afterwards. Stage 3 is what catches mistyped and dead domains, which is where
 * hard bounces actually come from.
 */

export type Verdict = 'deliverable' | 'undeliverable' | 'risky' | 'unknown';

export type VerificationCode =
  | 'OK'
  | 'SYNTAX_INVALID'
  | 'RESERVED_DOMAIN'
  | 'DOMAIN_NOT_FOUND'
  | 'NO_MAIL_EXCHANGER'
  | 'NULL_MX'
  | 'MAILBOX_NOT_FOUND'
  | 'PLACEHOLDER_ADDRESS'
  | 'DISPOSABLE_DOMAIN'
  | 'ROLE_ADDRESS'
  | 'LIKELY_TYPO'
  | 'CATCH_ALL_DOMAIN'
  | 'MAILBOX_FULL'
  | 'DNS_UNAVAILABLE'
  | 'CHECK_DISABLED';

export type StageResult = 'pass' | 'fail' | 'unknown' | 'skipped';

export interface AddressVerification {
  /** As supplied, for echoing beside the field somebody typed it into. */
  input: string;
  /** Trimmed, unwrapped, domain lower-cased and punycoded. */
  address: string;
  domain: string;
  verdict: Verdict;
  code: VerificationCode;
  /** One sentence, written for the person who typed the address. */
  reason: string;
  checks: { syntax: StageResult; domain: StageResult; mx: StageResult; mailbox: StageResult };
  /** Exchanger hostnames in priority order. Empty when there are none. */
  mail_exchangers: string[];
  is_role_address: boolean;
  is_disposable: boolean;
  is_placeholder: boolean;
  /** A correction to OFFER. Never one to apply. */
  did_you_mean: string | null;
  checked_at: string;
  cached: boolean;
}

export interface SendDecision {
  allowed: boolean;
  /** Present whenever `allowed` is false. */
  reason: string | null;
  verdict: Verdict;
  code: VerificationCode;
}

/**
 * The deployed kill-switch, unchanged in name and meaning.
 *
 * EMAIL_VALIDATION_MODE = off | soft | strict already exists, is documented and
 * is set in .env.prod, so this reads the same variable rather than inventing a
 * second one that could disagree with it. `off` skips the network entirely;
 * `soft` checks and reports but never blocks; `strict` blocks.
 */
export type ValidationMode = 'off' | 'soft' | 'strict';

export function validationMode(): ValidationMode {
  const m = (process.env.EMAIL_VALIDATION_MODE || 'off').trim().toLowerCase();
  return m === 'soft' || m === 'strict' ? m : 'off';
}

function envInt(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envFlag(name: string, fallback: boolean): boolean {
  const raw = (process.env[name] || '').trim().toLowerCase();
  if (raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function settings() {
  return {
    mode: validationMode(),
    dnsTimeoutMs: envInt('EMAIL_DNS_TIMEOUT_MS', 5000),
    probe: envFlag('EMAIL_SMTP_PROBE', false),
    probeTimeoutMs: envInt('EMAIL_SMTP_PROBE_TIMEOUT_MS', 8000),
    probeFrom:
      process.env.EMAIL_SMTP_PROBE_FROM || process.env.FROM_EMAIL ||
      process.env.SENDGRID_FROM_EMAIL || 'postmaster@localhost',
    heloName:
      process.env.EMAIL_SMTP_HELO_NAME ||
      (process.env.FROM_EMAIL || '').split('@')[1] || 'localhost',
    /* Reachable but not worth sending to. Each has its own switch because each
       is policy rather than fact; both default on, because a campaign fired at
       four hundred placeholders out of one import is a reputation incident. */
    blockPlaceholder: envFlag('EMAIL_BLOCK_PLACEHOLDER', true),
    blockDisposable: envFlag('EMAIL_BLOCK_DISPOSABLE', true),
    /* Off: sales@ and info@ are the right address for a great deal of business. */
    blockRole: envFlag('EMAIL_BLOCK_ROLE', false),
    disposableDomains: new Set(
      (process.env.EMAIL_DISPOSABLE_DOMAINS || '')
        .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    ) as ReadonlySet<string>,
    ttl: {
      deliverable: envInt('EMAIL_CACHE_TTL_DELIVERABLE_MS', 30 * 24 * 60 * 60 * 1000),
      /* Days, not weeks: a domain gets an MX record the day its owner finishes
         setting up mail, and a long cache keeps refusing them after that. */
      undeliverable: envInt('EMAIL_CACHE_TTL_UNDELIVERABLE_MS', 3 * 24 * 60 * 60 * 1000),
      risky: envInt('EMAIL_CACHE_TTL_RISKY_MS', 24 * 60 * 60 * 1000),
      /* Minutes. `unknown` describes OUR network at one moment. */
      unknown: envInt('EMAIL_CACHE_TTL_UNKNOWN_MS', 5 * 60 * 1000),
      mx: envInt('EMAIL_CACHE_TTL_MX_MS', 6 * 60 * 60 * 1000),
    },
  };
}

interface MxLookup {
  status: 'ok' | 'implicit' | 'null_mx' | 'no_mx' | 'nxdomain' | 'unavailable';
  hosts: string[];
}

interface ProbeOutcome {
  status: 'accepted' | 'rejected' | 'full' | 'catch_all' | 'unavailable';
  detail: string;
}

/* ------------------------------------------------------------------ caches */

interface CacheEntry<T> { value: T; expiresAt: number }

/**
 * IN-PROCESS ONLY, deliberately.
 *
 * Two caches keyed differently, because a 5,000-recipient campaign at one
 * company is 5,000 address lookups and ONE domain lookup — keying only by
 * address would issue 5,000 identical DNS queries.
 *
 * NO DATABASE TABLE, unlike the equivalent in LeadFlow. This SDK shares the
 * platform Postgres with every tenant on the box, and a migration there is a
 * heavier commitment than a cache needs. The cost of a cold process is one DNS
 * query per domain; if a durable cache is ever wanted, it belongs behind the
 * same functions and changes nothing for callers.
 *
 * BOUNDED. An unbounded Map behind an HTTP route is a memory-exhaustion bug
 * with a friendly name.
 */
const MAX_MEMO = 5_000;
const domainMemo = new Map<string, CacheEntry<MxLookup>>();
const addressMemo = new Map<string, CacheEntry<AddressVerification>>();

function memoGet<T>(memo: Map<string, CacheEntry<T>>, key: string): T | null {
  const hit = memo.get(key);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) { memo.delete(key); return null; }
  return hit.value;
}

function memoSet<T>(memo: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
  if (memo.size >= MAX_MEMO) {
    const oldest = memo.keys().next();
    if (!oldest.done) memo.delete(oldest.value);
  }
  memo.set(key, { value, expiresAt: Date.now() + ttlMs });
}

/** Drop every cached verdict. For tests, and for an operator who fixed DNS. */
export function clearVerificationCache(): void {
  domainMemo.clear();
  addressMemo.clear();
}

/* --------------------------------------------------------------------- DNS */

/**
 * Find the mail exchangers for a domain.
 *
 * THE A/AAAA FALLBACK IS NOT A GUESS: RFC 5321 §5.1 makes a domain with an
 * address record and no MX its own mail exchanger, and many small-business
 * domains are configured exactly that way. Treating "no MX" as "cannot receive"
 * would refuse real customers — the expensive direction of this error.
 *
 * A NULL MX IS THE ONE DEFINITIVE NO. RFC 7505 defines a single `.` exchanger
 * as the owner stating the domain accepts no mail. That is the domain telling
 * us, and it is believed.
 */
async function resolveExchangers(domain: string): Promise<MxLookup> {
  const cached = memoGet(domainMemo, domain);
  if (cached) return cached;

  const cfg = settings();
  const resolver = new Resolver({ timeout: cfg.dnsTimeoutMs, tries: 2 });

  let result: MxLookup;
  try {
    const records = await resolver.resolveMx(domain);
    const usable = records.filter((r) => r.exchange && r.exchange !== '.');
    if (records.length > 0 && usable.length === 0) {
      result = { status: 'null_mx', hosts: [] };
    } else if (usable.length === 0) {
      result = await addressRecordFallback(resolver, domain);
    } else {
      result = {
        status: 'ok',
        hosts: usable.sort((a, b) => a.priority - b.priority).map((r) => r.exchange.replace(/\.$/, '')),
      };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENODATA' || code === 'ENOTFOUND') {
      /* ENODATA is "domain exists, no MX"; ENOTFOUND is returned by some
         resolvers for both "no such domain" and "no such record", so neither
         can be concluded without asking for an address record. */
      result = await addressRecordFallback(resolver, domain);
    } else {
      result = { status: 'unavailable', hosts: [] };
    }
  }

  /* A failed lookup caches for MINUTES, a successful one for hours. Caching a
     resolver timeout for six hours turns a blip into an afternoon of refusals. */
  memoSet(domainMemo, domain, result, result.status === 'unavailable' ? cfg.ttl.unknown : cfg.ttl.mx);
  return result;
}

async function addressRecordFallback(resolver: Resolver, domain: string): Promise<MxLookup> {
  try {
    if ((await resolver.resolve4(domain)).length > 0) return { status: 'implicit', hosts: [domain] };
  } catch {
    // Fall through to AAAA — an IPv6-only mail host is unusual, not impossible.
  }
  try {
    if ((await resolver.resolve6(domain)).length > 0) return { status: 'implicit', hosts: [domain] };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOTFOUND' || code === 'ENODATA') return { status: 'nxdomain', hosts: [] };
    return { status: 'unavailable', hosts: [] };
  }
  return { status: 'no_mx', hosts: [] };
}

/* -------------------------------------------------------------------- SMTP */

/**
 * Ask the exchanger whether it would accept this recipient.
 *
 * OFF BY DEFAULT AND IT SHOULD STAY OFF HERE. Three reasons, none theoretical:
 * outbound port 25 is blocked on EC2 (this platform's host) unless AWS grants
 * an exception, so every check would burn its timeout to learn nothing; opening
 * sessions and disconnecting costs the sending IP its reputation with the large
 * providers, which is the very thing this is meant to protect; and catch-all
 * domains accept every RCPT, so the answer is frequently a lie — which is why a
 * catch-all is detected explicitly and downgrades to `risky`.
 *
 * IT NEVER SENDS A MESSAGE: the session stops at RCPT and quits. DATA is never
 * issued, so nothing can arrive in the mailbox being asked about.
 */
async function probeMailbox(host: string, address: string, domain: string): Promise<ProbeOutcome> {
  const cfg = settings();
  const decoy = `${randomBytes(9).toString('hex')}@${domain}`;

  return new Promise<ProbeOutcome>((resolve) => {
    let socket: Socket;
    try {
      socket = createConnection({ host, port: 25 });
    } catch (error) {
      resolve({ status: 'unavailable', detail: error instanceof Error ? error.message : 'connect failed' });
      return;
    }

    let buffer = '';
    let stage: 'greeting' | 'ehlo' | 'from' | 'decoy' | 'target' = 'greeting';
    let triedHelo = false;
    let settled = false;

    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      try { socket.write('QUIT\r\n'); } catch { /* going away regardless */ }
      socket.destroy();
      resolve(outcome);
    };

    // A deadline for the WHOLE session, not just an idle socket: a server that
    // answers every command slowly would never trip the idle timeout.
    const deadline = setTimeout(
      () => finish({ status: 'unavailable', detail: 'the mail server did not finish the check in time' }),
      cfg.probeTimeoutMs,
    );
    deadline.unref();

    socket.setTimeout(cfg.probeTimeoutMs);
    socket.on('timeout', () => finish({ status: 'unavailable', detail: 'the mail server did not answer in time' }));
    socket.on('error', (error) => finish({ status: 'unavailable', detail: error.message }));
    socket.on('close', () => {
      clearTimeout(deadline);
      finish({ status: 'unavailable', detail: 'the mail server closed the connection' });
    });

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      // A reply is complete when a line has a SPACE after the code; a hyphen
      // means more lines follow (RFC 5321 §4.2.1). Acting on the first line of a
      // multi-line EHLO answer is the classic way to break this.
      const match = /^(\d{3}) [^\n]*$/m.exec(buffer.replace(/\r/g, ''));
      if (!match) return;
      const code = Number.parseInt(match[1], 10);
      buffer = '';

      switch (stage) {
        case 'greeting':
          if (code !== 220) return finish({ status: 'unavailable', detail: `the mail server refused the connection (${code})` });
          stage = 'ehlo';
          socket.write(`EHLO ${cfg.heloName}\r\n`);
          return;
        case 'ehlo':
          if (code >= 500 && !triedHelo) { triedHelo = true; socket.write(`HELO ${cfg.heloName}\r\n`); return; }
          if (code !== 250) return finish({ status: 'unavailable', detail: `the mail server rejected the greeting (${code})` });
          stage = 'from';
          socket.write(`MAIL FROM:<${cfg.probeFrom}>\r\n`);
          return;
        case 'from':
          if (code !== 250) return finish({ status: 'unavailable', detail: `the mail server would not accept a sender (${code})` });
          /* THE DECOY GOES FIRST. Asking about a random mailbox at the same
             domain is the only way to tell "that person exists" from "yes, to
             everything" — and it must be asked BEFORE the real one, or a
             catch-all has already given the answer we would misread. */
          stage = 'decoy';
          socket.write(`RCPT TO:<${decoy}>\r\n`);
          return;
        case 'decoy':
          if (code >= 200 && code < 300) {
            return finish({ status: 'catch_all', detail: 'the domain accepts mail for every address' });
          }
          stage = 'target';
          socket.write(`RCPT TO:<${address}>\r\n`);
          return;
        case 'target':
          if (code >= 200 && code < 300) return finish({ status: 'accepted', detail: '' });
          if (code === 452 || code === 552) return finish({ status: 'full', detail: 'the mailbox is over quota' });
          if (code >= 500) return finish({ status: 'rejected', detail: `no such mailbox (${code})` });
          /* 4xx is a deferral — greylisting, rate limiting, a bad afternoon. It
             says nothing about the address and must not be recorded as if it did. */
          return finish({ status: 'unavailable', detail: `the mail server deferred the check (${code})` });
        default:
          return;
      }
    });
  });
}

/* ----------------------------------------------------------- the algorithm */

function build(
  input: string, address: string, domain: string,
  verdict: Verdict, code: VerificationCode, reason: string,
  checks: AddressVerification['checks'],
  extras: Partial<AddressVerification> = {},
): AddressVerification {
  return {
    input, address, domain, verdict, code, reason, checks,
    mail_exchangers: [],
    is_role_address: false,
    is_disposable: false,
    is_placeholder: false,
    did_you_mean: null,
    checked_at: new Date().toISOString(),
    cached: false,
    ...extras,
  };
}

/**
 * Downgrade an otherwise-fine verdict for what the policy stage found.
 *
 * APPLIED LAST, and only to addresses that are otherwise deliverable. A
 * placeholder at a dead domain is reported as a dead domain, because that is
 * the fact — and "did you mean" advice about a mailbox nobody could reach is
 * noise.
 */
function policyOverlay(
  result: AddressVerification,
  flags: { is_placeholder: boolean; is_disposable: boolean; is_role_address: boolean; did_you_mean: string | null },
): AddressVerification {
  if (flags.is_placeholder) {
    return { ...result, verdict: 'risky', code: 'PLACEHOLDER_ADDRESS',
      reason: `"${result.address}" looks like a placeholder somebody typed to get past a form rather than a real person's address.` };
  }
  if (flags.is_disposable) {
    return { ...result, verdict: 'risky', code: 'DISPOSABLE_DOMAIN',
      reason: `"${result.domain}" is a throwaway-inbox provider: the address works now and will stop working shortly.` };
  }
  if (flags.did_you_mean) {
    return { ...result, verdict: 'risky', code: 'LIKELY_TYPO',
      reason: `"${result.domain}" takes mail, but it is one character away from ${flags.did_you_mean.split('@')[1]} — did you mean ${flags.did_you_mean}?` };
  }
  if (flags.is_role_address) {
    return { ...result, verdict: 'risky', code: 'ROLE_ADDRESS',
      reason: `"${result.address}" is a shared inbox rather than one person's address.` };
  }
  return result;
}

function finalise(result: AddressVerification, ttl: ReturnType<typeof settings>['ttl']): AddressVerification {
  const ms = result.verdict === 'deliverable' ? ttl.deliverable
    : result.verdict === 'undeliverable' ? ttl.undeliverable
      : result.verdict === 'risky' ? ttl.risky : ttl.unknown;
  memoSet(addressMemo, result.address, result, ms);
  return result;
}

/**
 * Verify one address. NEVER THROWS and never rejects.
 *
 * @param raw     Whatever the user, import file or API caller supplied.
 * @param options `probe` overrides the deployment default for stage 4;
 *                `skipCache` forces a fresh check, for a "check again" control;
 *                `force` runs the network stages even when EMAIL_VALIDATION_MODE
 *                is `off`.
 *
 * WHY `force` EXISTS. The mode governs whether a verdict may BLOCK a send, and
 * that is a different question from whether anybody may ask for one. An
 * operator who opens the portal and types an address into the checker wants the
 * answer regardless of the deployment's enforcement stance, and the compatibility
 * shim in sdk-notification assesses unconditionally because that is what its
 * previous implementation did. Neither of those should be silenced by a
 * kill-switch aimed at the send path.
 */
export async function verifyAddress(
  raw: string,
  options: { probe?: boolean; skipCache?: boolean; force?: boolean } = {},
): Promise<AddressVerification> {
  const cfg = settings();

  /* Stage 1 runs even when checking is disabled: a string with no @ in it is
     not a network question, and answering "unknown" to it would be silly. */
  const parsed = parseAddress(raw);
  if (!parsed.ok) {
    return build(raw, '', '', 'undeliverable', 'SYNTAX_INVALID', parsed.reason,
      { syntax: 'fail', domain: 'skipped', mx: 'skipped', mailbox: 'skipped' });
  }
  const { address, local, domain } = parsed;

  if (cfg.mode === 'off' && !options.force) {
    return build(raw, address, domain, 'unknown', 'CHECK_DISABLED',
      'Address checking is disabled in this deployment (EMAIL_VALIDATION_MODE=off); only the format was checked.',
      { syntax: 'pass', domain: 'skipped', mx: 'skipped', mailbox: 'skipped' });
  }

  if (!options.skipCache) {
    const hit = memoGet(addressMemo, address);
    if (hit) return { ...hit, input: raw, cached: true };
  }

  /* Stage 2. RESERVED IS CHECKED FIRST because example.com RESOLVES: it has an
     A record and would sail past the DNS stage while being, by IETF
     reservation, incapable of receiving anything. */
  const flags = {
    is_role_address: isRoleAddress(local),
    is_disposable: isDisposableDomain(domain, cfg.disposableDomains),
    is_placeholder: isPlaceholderAddress(local),
    did_you_mean: (() => { const s = suggestDomain(domain); return s ? `${local}@${s}` : null; })(),
  };

  if (isReservedDomain(domain)) {
    return finalise(build(raw, address, domain, 'undeliverable', 'RESERVED_DOMAIN',
      `"${domain}" is a reserved documentation or test domain — it is guaranteed by standard never to receive email.`,
      { syntax: 'pass', domain: 'fail', mx: 'skipped', mailbox: 'skipped' }, flags), cfg.ttl);
  }

  /* Stage 3 — the stage the platform relies on. */
  const mx = await resolveExchangers(domain);

  if (mx.status === 'nxdomain') {
    return finalise(build(raw, address, domain, 'undeliverable', 'DOMAIN_NOT_FOUND',
      `There is no domain called "${domain}"${flags.did_you_mean ? ` — did you mean ${flags.did_you_mean}?` : '.'}`,
      { syntax: 'pass', domain: 'fail', mx: 'skipped', mailbox: 'skipped' }, flags), cfg.ttl);
  }
  if (mx.status === 'null_mx') {
    return finalise(build(raw, address, domain, 'undeliverable', 'NULL_MX',
      `"${domain}" publishes a null MX record: its owner has declared that it accepts no email at all.`,
      { syntax: 'pass', domain: 'pass', mx: 'fail', mailbox: 'skipped' }, flags), cfg.ttl);
  }
  if (mx.status === 'no_mx') {
    return finalise(build(raw, address, domain, 'undeliverable', 'NO_MAIL_EXCHANGER',
      `"${domain}" exists but has no mail server behind it, so email sent there cannot be delivered.`,
      { syntax: 'pass', domain: 'pass', mx: 'fail', mailbox: 'skipped' }, flags), cfg.ttl);
  }
  if (mx.status === 'unavailable') {
    /* FAIL OPEN, cached for minutes. Our resolver being unreachable is not
       evidence about somebody else's address — this is the case the previous
       guard reported as `no-mx` and suppressed on. */
    return finalise(build(raw, address, domain, 'unknown', 'DNS_UNAVAILABLE',
      `The mail server for "${domain}" could not be looked up just now, so this address has not been confirmed either way.`,
      { syntax: 'pass', domain: 'unknown', mx: 'unknown', mailbox: 'skipped' }, flags), cfg.ttl);
  }

  const withMx = { ...flags, mail_exchangers: mx.hosts };
  const probing = options.probe ?? cfg.probe;

  /* Stage 4, when the deployment has asked for it. */
  if (probing && mx.hosts.length > 0) {
    const outcome = await probeMailbox(mx.hosts[0], address, domain);
    if (outcome.status === 'rejected') {
      return finalise(build(raw, address, domain, 'undeliverable', 'MAILBOX_NOT_FOUND',
        `The mail server for "${domain}" says there is no mailbox called "${local}".`,
        { syntax: 'pass', domain: 'pass', mx: 'pass', mailbox: 'fail' }, withMx), cfg.ttl);
    }
    if (outcome.status === 'catch_all') {
      return finalise(build(raw, address, domain, 'risky', 'CATCH_ALL_DOMAIN',
        `"${domain}" accepts mail addressed to anything, so whether "${local}" is a real mailbox cannot be confirmed.`,
        { syntax: 'pass', domain: 'pass', mx: 'pass', mailbox: 'unknown' }, withMx), cfg.ttl);
    }
    if (outcome.status === 'full') {
      return finalise(build(raw, address, domain, 'risky', 'MAILBOX_FULL',
        'The mailbox exists but is over quota, so a message may bounce.',
        { syntax: 'pass', domain: 'pass', mx: 'pass', mailbox: 'unknown' }, withMx), cfg.ttl);
    }
    if (outcome.status === 'accepted') {
      return finalise(policyOverlay(build(raw, address, domain, 'deliverable', 'OK',
        `"${address}" is a real mailbox at a domain that accepts mail.`,
        { syntax: 'pass', domain: 'pass', mx: 'pass', mailbox: 'pass' }, withMx), flags), cfg.ttl);
    }
    // Unavailable: fall through to the MX-only verdict rather than reporting a
    // worse answer than we held before the probe was attempted.
    return finalise(policyOverlay(build(raw, address, domain, 'deliverable', 'OK',
      `"${domain}" has a mail server that accepts email. The mailbox itself could not be checked (${outcome.detail}).`,
      { syntax: 'pass', domain: 'pass', mx: 'pass', mailbox: 'unknown' }, withMx), flags), cfg.ttl);
  }

  return finalise(policyOverlay(build(raw, address, domain, 'deliverable', 'OK',
    mx.status === 'implicit'
      ? `"${domain}" has no MX record but resolves, so it is its own mail server and can receive email.`
      : `"${domain}" has a mail server (${mx.hosts[0]}) that accepts email.`,
    { syntax: 'pass', domain: 'pass', mx: 'pass', mailbox: probing ? 'unknown' : 'skipped' },
    withMx), flags), cfg.ttl);
}

/**
 * May we send to this address?
 *
 * BLOCKS ON FACTS, WARNS ON JUDGEMENT. `undeliverable` is the only verdict that
 * stops a send by itself, because it is the only one meaning the message has
 * nowhere to go. Placeholder and disposable are reachable mailboxes and are
 * therefore policy, each with its own switch.
 *
 * `unknown` ALWAYS PASSES, in every mode. The alternative is that a DNS outage
 * on our side stops every notification on the platform, which is a far larger
 * failure than the bounces it would avoid.
 *
 * NOTHING BLOCKS OUTSIDE `strict`, so the existing rollout stance is preserved:
 * `soft` measures what strict would do without acting on it.
 */
export function sendDecision(result: AddressVerification): SendDecision {
  const cfg = settings();
  const base = { verdict: result.verdict, code: result.code };
  if (cfg.mode !== 'strict') return { allowed: true, reason: null, ...base };
  if (result.verdict === 'undeliverable') return { allowed: false, reason: result.reason, ...base };
  if (result.code === 'PLACEHOLDER_ADDRESS' && cfg.blockPlaceholder) return { allowed: false, reason: result.reason, ...base };
  if (result.code === 'DISPOSABLE_DOMAIN' && cfg.blockDisposable) return { allowed: false, reason: result.reason, ...base };
  if (result.code === 'ROLE_ADDRESS' && cfg.blockRole) return { allowed: false, reason: result.reason, ...base };
  return { allowed: true, reason: null, ...base };
}

/** Verify and decide in one call — what a send path wants. */
export async function checkBeforeSending(
  address: string,
): Promise<{ verification: AddressVerification; decision: SendDecision }> {
  const verification = await verifyAddress(address);
  return { verification, decision: sendDecision(verification) };
}

/**
 * Verify many addresses, for an import preview or a campaign audience.
 *
 * BOUNDED CONCURRENCY: the point of a bulk check is not to open ten thousand
 * simultaneous DNS queries. Duplicates collapse before the work starts, and the
 * domain cache means a single-company list costs one lookup.
 */
export async function verifyAddresses(
  addresses: string[],
  options: { probe?: boolean; concurrency?: number; force?: boolean } = {},
): Promise<AddressVerification[]> {
  const limit = Math.max(1, Math.min(options.concurrency ?? 8, 16));
  const unique = [...new Set(addresses.map((a) => (a ?? '').trim()).filter((a) => a !== ''))];
  const results: AddressVerification[] = [];
  for (let i = 0; i < unique.length; i += limit) {
    const batch = unique.slice(i, i + limit);
    // eslint-disable-next-line no-await-in-loop -- the batching is the point
    results.push(...await Promise.all(
      batch.map((a) => verifyAddress(a, { probe: options.probe, force: options.force })),
    ));
  }
  return results;
}

/** What is this deployment actually checking? Returned with every API answer. */
export function describeConfiguration(): Record<string, unknown> {
  const cfg = settings();
  return {
    mode: cfg.mode,
    stages: {
      syntax: true,
      reserved_and_placeholder: cfg.mode !== 'off',
      mx: cfg.mode !== 'off',
      mailbox_probe: cfg.probe,
    },
    blocks: {
      undeliverable: cfg.mode === 'strict',
      placeholder: cfg.mode === 'strict' && cfg.blockPlaceholder,
      disposable: cfg.mode === 'strict' && cfg.blockDisposable,
      role: cfg.mode === 'strict' && cfg.blockRole,
    },
    mailbox_probe_note: cfg.probe
      ? 'SMTP RCPT probing is enabled. It needs outbound port 25, which cloud networks block by default.'
      : 'SMTP RCPT probing is disabled, so a specific mailbox is never confirmed to exist — only that its domain can receive mail.',
  };
}

/** Mask an address for logs: first local character, then the full domain. */
export function maskAddress(address: string): string {
  const email = (address || '').trim();
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = email.slice(0, at);
  return `${local[0] ?? ''}${'*'.repeat(Math.max(1, local.length - 1))}@${email.slice(at + 1)}`;
}
