import { domainToASCII } from 'node:url';

/**
 * Stage one of address verification: is this a well-formed address, and what
 * KIND of address is it? Pure, synchronous, no network.
 *
 * NOT A REGEX, and that is the point of the file. The pattern this supersedes —
 * `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`, still the shape used by the identity
 * validator — accepts `a@-.--`, `a@b..c`, a 400-character local part and a
 * trailing dot, and rejects nothing anybody actually mistypes. The failures
 * that produce bounces are structural: a label starting with a hyphen, a
 * doubled dot, an address over the 254-octet SMTP path limit. Structure is what
 * a parser checks and a pattern approximates.
 *
 * DELIBERATELY NARROWER THAN RFC 5322, which permits comments, folding
 * whitespace and source routes that no submission API will carry. Accepting
 * them would only move the rejection to SendGrid or SES, where the reason is a
 * 400 body nobody reads. What is accepted is RFC 5321 dot-atom plus the
 * quoted-string form — what mail systems in production actually carry.
 */

export type SyntaxCode =
  | 'OK'
  | 'EMPTY'
  | 'NO_AT_SIGN'
  | 'LOCAL_PART_EMPTY'
  | 'LOCAL_PART_TOO_LONG'
  | 'LOCAL_PART_INVALID'
  | 'DOMAIN_EMPTY'
  | 'DOMAIN_INVALID'
  | 'DOMAIN_LABEL_INVALID'
  | 'DOMAIN_NOT_FQDN'
  | 'IP_LITERAL_DOMAIN'
  | 'ADDRESS_TOO_LONG';

export interface SyntaxResult {
  ok: boolean;
  code: SyntaxCode;
  /** A sentence a person can act on. Empty when `ok`. */
  reason: string;
  /** Normalised: trimmed, unwrapped, domain lower-cased and punycoded. */
  address: string;
  local: string;
  domain: string;
}

/** RFC 5321 §4.5.3.1: 64 octets of local part, 254 of forward path. */
const MAX_LOCAL = 64;
const MAX_ADDRESS = 254;
const MAX_LABEL = 63;

/** RFC 5322 atext — what an unquoted local part may contain. */
const ATEXT = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+$/;
/** LDH: letters, digits, hyphen — never at either end. */
const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;

/**
 * Domains reserved by standard, which can never receive mail.
 *
 * RFC 2606 AND RFC 6761 RESERVE THESE, which is what separates this list from
 * every heuristic below it: it is not a judgement. `example.com` exists so it
 * can appear in documentation without reaching anybody; `.test`, `.invalid` and
 * `.localhost` are reserved so they can never be delegated.
 *
 * THIS IS ALSO THE LIST THAT LETS THE CHECK BE TURNED ON AT ALL. The existing
 * guard defaults to `off` because the api-test suite registers accounts at
 * `@example.com` and `*.test`, and a check that treats those as ordinary
 * failures breaks CI. Naming them as reserved makes the CI case explicit rather
 * than collateral: those addresses are undeliverable by definition, the suite
 * asserts registration succeeds anyway (it does — the send is skipped, not the
 * account), and real domains are unaffected.
 */
const RESERVED_DOMAINS = new Set([
  'example.com', 'example.net', 'example.org', 'example.edu', 'localhost',
]);
const RESERVED_TLDS = new Set(['test', 'example', 'invalid', 'localhost', 'local']);

/**
 * Mailbox names that belong to a function rather than a person.
 *
 * NEVER BLOCKS ON ITS OWN. `sales@` and `info@` are the correct address for a
 * great deal of business correspondence; this only reports, and the caller
 * decides whether it matters for the message being sent.
 */
const ROLE_LOCAL_PARTS = new Set([
  'abuse', 'admin', 'administrator', 'billing', 'careers', 'compliance', 'contact',
  'customerservice', 'enquiries', 'enquiry', 'finance', 'help', 'hello', 'hostmaster',
  'hr', 'info', 'inquiries', 'it', 'jobs', 'legal', 'mail', 'marketing', 'news',
  'noc', 'noreply', 'no-reply', 'donotreply', 'do-not-reply', 'notifications',
  'office', 'orders', 'postmaster', 'privacy', 'recruitment', 'root', 'sales',
  'security', 'service', 'support', 'team', 'webmaster',
]);

/**
 * Placeholders somebody typed to get past a form.
 *
 * NOT UNDELIVERABLE — `test@acme.com` may be a real mailbox — which is why
 * these get their own verdict rather than joining the reserved list. What they
 * are not is a person worth spending sender reputation on, and they arrive in
 * bulk from half-finished imports and abandoned sign-ups.
 */
const PLACEHOLDER_LOCAL_PARTS = new Set([
  'a', 'aa', 'aaa', 'abc', 'asd', 'asdf', 'asdfasdf', 'demo', 'dummy', 'example',
  'fake', 'foo', 'foobar', 'bar', 'baz', 'nobody', 'none', 'placeholder', 'qa',
  'qwerty', 'sample', 'test', 'test1', 'test123', 'testing', 'testuser', 'tester',
  'trial', 'user', 'x', 'xx', 'xxx', 'yourname', 'youremail', 'zzz',
]);

/**
 * Throwaway-inbox providers. Extended per deployment by EMAIL_DISPOSABLE_DOMAINS,
 * which is an existing variable and keeps its meaning.
 */
const DISPOSABLE_DOMAINS = new Set([
  '10minutemail.com', 'discard.email', 'dispostable.com', 'emailondeck.com',
  'fakeinbox.com', 'getairmail.com', 'getnada.com', 'guerrillamail.com',
  'guerrillamail.net', 'inboxbear.com', 'mailcatch.com', 'maildrop.cc',
  'mailinator.com', 'mailnesia.com', 'mintemail.com', 'mohmal.com', 'moakt.com',
  'sharklasers.com', 'spam4.me', 'spamgourmet.com', 'temp-mail.org', 'tempmail.com',
  'tempr.email', 'throwawaymail.com', 'trashmail.com', 'yopmail.com',
]);

/**
 * The domains people mistype. SUGGESTED, NEVER SUBSTITUTED — `ada@gmial.com` is
 * a perfect address at a domain that exists and takes mail, so no later stage
 * will ever catch it, and silently correcting it would send somebody's password
 * reset to an address they did not type.
 */
const COMMON_DOMAINS = [
  'aol.com', 'comcast.net', 'gmail.com', 'googlemail.com', 'hotmail.com',
  'hotmail.co.uk', 'icloud.com', 'live.com', 'mac.com', 'me.com', 'msn.com',
  'outlook.com', 'proton.me', 'protonmail.com', 'yahoo.com', 'yahoo.co.uk',
  'ymail.com',
];

/** Anything SMTP cannot put on the wire. Checked by code point, not by regex. */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Optimal string alignment distance, capped. Transpositions count as one. */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) rows.push([i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      // `gmial`/`gmail` is ONE swap, and swaps are the most common typing error;
      // scoring them as two edits loses the case this exists for.
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + cost);
      }
    }
  }
  return rows[a.length][b.length];
}

function fail(code: SyntaxCode, reason: string): SyntaxResult {
  return { ok: false, code, reason, address: '', local: '', domain: '' };
}

/**
 * Parse and normalise one address.
 *
 * THE LOCAL PART KEEPS ITS CASE, the domain does not. Domains are
 * case-insensitive by DNS; local parts are case-SENSITIVE by RFC 5321 §2.4 and
 * only convention makes them otherwise. A caller that needs a case-insensitive
 * key lower-cases for that purpose — a different decision from rewriting the
 * address a message is addressed to.
 */
export function parseAddress(raw: string): SyntaxResult {
  if (typeof raw !== 'string') return fail('EMPTY', 'No address was supplied.');

  // `Ada Lovelace <ada@acme.com>` is what a paste from a mail client gives you,
  // and rejecting it teaches the user nothing.
  let value = raw.trim();
  const angled = /<([^<>]*)>\s*$/.exec(value);
  if (angled) value = angled[1].trim();

  if (value === '') return fail('EMPTY', 'No address was supplied.');
  if (/\s/.test(value) || hasControlCharacter(value)) {
    return fail('LOCAL_PART_INVALID', 'An email address cannot contain spaces or control characters.');
  }

  const at = value.lastIndexOf('@');
  if (at === -1) return fail('NO_AT_SIGN', 'An email address needs an @ sign, as in name@company.com.');

  const local = value.slice(0, at);
  const domainRaw = value.slice(at + 1);

  if (local === '') return fail('LOCAL_PART_EMPTY', 'There is nothing before the @ sign.');
  if (local.length > MAX_LOCAL) {
    return fail('LOCAL_PART_TOO_LONG', `The part before the @ is ${local.length} characters; mail systems accept at most ${MAX_LOCAL}.`);
  }

  // The quoted form ("very.unusual@name"@example.com) is legal and rare. It is
  // accepted rather than rejected — refusing a valid address is the worse error
  // — but nothing inside the quotes is second-guessed.
  const quoted = local.startsWith('"') && local.endsWith('"') && local.length >= 2;
  if (!quoted) {
    if (local.startsWith('.') || local.endsWith('.')) {
      return fail('LOCAL_PART_INVALID', 'The part before the @ cannot start or end with a dot.');
    }
    if (local.includes('..')) {
      return fail('LOCAL_PART_INVALID', 'The part before the @ contains two dots in a row.');
    }
    for (const atom of local.split('.')) {
      if (atom === '' || !ATEXT.test(atom)) {
        return fail('LOCAL_PART_INVALID', `"${local}" is not a usable mailbox name — it contains a character mail systems will not accept.`);
      }
    }
  }

  if (domainRaw === '') return fail('DOMAIN_EMPTY', 'There is nothing after the @ sign.');
  if (domainRaw.startsWith('[')) {
    /* [192.0.2.1] is valid RFC 5321 and undeliverable in practice: no provider
       relays to a bare IP, and every one seen in the wild has been a paste error
       or an injection attempt. */
    return fail('IP_LITERAL_DOMAIN', 'An address at a bare IP address cannot be delivered to. Use the domain name instead.');
  }

  /* IDN to punycode BEFORE the structural checks, because the length and label
     rules are defined on the ASCII form: münchen.de is 10 characters and
     xn--mnchen-3ya.de is 17, and DNS has to fit the second one. */
  const domain = domainToASCII(domainRaw.toLowerCase());
  if (domain === '') return fail('DOMAIN_INVALID', `"${domainRaw}" is not a valid domain name.`);
  if (domain.endsWith('.')) return fail('DOMAIN_INVALID', 'The domain cannot end with a dot.');

  const labels = domain.split('.');
  if (labels.length < 2) {
    return fail('DOMAIN_NOT_FQDN', `"${domainRaw}" has no domain ending — an address needs a full domain such as company.com.`);
  }
  for (const label of labels) {
    if (label === '' || label.length > MAX_LABEL || !LABEL.test(label)) {
      return fail('DOMAIN_LABEL_INVALID', `"${domainRaw}" is not a valid domain name — "${label || '(empty)'}" is not a usable part of one.`);
    }
  }
  const tld = labels[labels.length - 1];
  if (tld.length < 2 || /^\d+$/.test(tld) || tld.includes('-')) {
    // An all-numeric last label is a dotted quad without its brackets — the same
    // undeliverable case as the IP literal above.
    return fail('DOMAIN_INVALID', `"${domainRaw}" does not end in a real domain ending.`);
  }

  const address = `${local}@${domain}`;
  if (address.length > MAX_ADDRESS) {
    return fail('ADDRESS_TOO_LONG', `The address is ${address.length} characters; SMTP carries at most ${MAX_ADDRESS}.`);
  }

  return { ok: true, code: 'OK', reason: '', address, local, domain };
}

/** Reserved by standard, and therefore incapable of receiving mail. */
export function isReservedDomain(domain: string): boolean {
  const lower = domain.toLowerCase();
  if (RESERVED_DOMAINS.has(lower)) return true;
  const labels = lower.split('.');
  if (RESERVED_TLDS.has(labels[labels.length - 1])) return true;
  return [...RESERVED_DOMAINS].some((known) => lower.endsWith(`.${known}`));
}

/**
 * A placeholder rather than a person.
 *
 * The local part is matched WHOLE, never as a prefix: `testimonials@` and
 * `xavier@` are people, and a substring match would refuse to email them.
 */
export function isPlaceholderAddress(local: string): boolean {
  const base = local.toLowerCase().replace(/^"|"$/g, '').split('+')[0];
  if (PLACEHOLDER_LOCAL_PARTS.has(base)) return true;
  return /^(?:test|demo|sample|dummy|fake|placeholder|qa|foo|bar)(?:[._-]?\d*|[._-](?:user|account|mail|email|address|\d+))$/.test(base);
}

/** A shared/functional mailbox. Plus-addressing does not change the answer. */
export function isRoleAddress(local: string): boolean {
  return ROLE_LOCAL_PARTS.has(local.toLowerCase().split('+')[0]);
}

/** A known throwaway-inbox provider, including its unlimited subdomains. */
export function isDisposableDomain(domain: string, extra: ReadonlySet<string>): boolean {
  const lower = domain.toLowerCase();
  if (DISPOSABLE_DOMAINS.has(lower) || extra.has(lower)) return true;
  return [...DISPOSABLE_DOMAINS, ...extra].some((known) => lower.endsWith(`.${known}`));
}

/**
 * The domain this was probably meant to be, or null.
 *
 * ONLY THE LARGE FREE PROVIDERS. Suggesting a correction to a corporate domain
 * means guessing somebody's employer from a two-character difference, and
 * `ada@acme.co` -> "did you mean acme.com?" is wrong more often than right.
 */
export function suggestDomain(domain: string): string | null {
  const lower = domain.toLowerCase();
  if (COMMON_DOMAINS.includes(lower)) return null;
  let best: string | null = null;
  let bestDistance = 3;
  for (const candidate of COMMON_DOMAINS) {
    const distance = editDistance(lower, candidate);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return bestDistance <= 2 ? best : null;
}
