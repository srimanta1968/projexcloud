import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  extractContacts,
  extractContactsBatch,
  verifyEvidence,
  setContactLlmAdjunct,
} from '../src/services/contactExtraction';
import { getContactBackend, despeak } from '../src/services/contactBackends';
import type { FieldProposal } from '../src/services/contactBackends';

/**
 * The taxonomy lookup is the only I/O in this path; stubbing it keeps these tests about
 * extraction. Schema resolution itself is asserted separately below by controlling what
 * the stub returns.
 */
const lookupMock = vi.hoisted(() => vi.fn());
vi.mock('@projexlight/sdk-taxonomy', () => ({ lookupExtractionSchema: lookupMock }));

const TENANT = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue(null); // builtin
  setContactLlmAdjunct(null);
});

const SIGNATURE = [
  'Jane Marie Okonkwo',
  'Head of Platform Engineering',
  'Acme Technologies Ltd',
  'Work: +44 20 7946 0958',
  'Mobile: 07700 900123',
  'jane.okonkwo@acme-tech.com',
  'support@acme-tech.com',
  'https://www.acme-tech.com',
].join('\n');

function fields(r: { candidates: Array<{ proposals: FieldProposal[] }> }): string[] {
  return r.candidates.flatMap((c) => c.proposals.map((p) => p.field));
}
function firstOf(r: { candidates: Array<{ proposals: FieldProposal[] }> }, field: string) {
  return r.candidates.flatMap((c) => c.proposals).find((p) => p.field === field);
}

describe('every proposal carries confidence and an evidence span (AC2)', () => {
  it('each proposal has a 0..1 confidence and a span that resolves in the raw input', async () => {
    const r = await extractContacts({
      tenant_id: TENANT,
      source_kind: 'EMAIL_SIGNATURE',
      raw: SIGNATURE,
    });
    const all = r.candidates.flatMap((c) => c.proposals);
    expect(all.length).toBeGreaterThan(0);
    for (const p of all) {
      expect(p.confidence).toBeGreaterThan(0);
      expect(p.confidence).toBeLessThanOrEqual(1);
      expect(p.evidence.end).toBeGreaterThan(p.evidence.start);
      // The span is not decorative: slicing it out must actually yield the value.
      expect(SIGNATURE.slice(p.evidence.start, p.evidence.end)).toBe(p.evidence.snippet);
      expect(verifyEvidence(SIGNATURE, p).ok).toBe(true);
    }
  });

  it('confidence reflects how unambiguous the signal was', async () => {
    const r = await extractContacts({
      tenant_id: TENANT,
      source_kind: 'EMAIL_SIGNATURE',
      raw: SIGNATURE,
    });
    // An RFC-shaped address is near-certain; a guessed person name is not.
    expect(firstOf(r, 'email')!.confidence).toBeGreaterThan(firstOf(r, 'full_name')!.confidence);
  });

  it('OCR text is reported less confidently than the same text pasted', async () => {
    const pasted = await extractContacts({ tenant_id: TENANT, source_kind: 'SMART_PASTE', raw: SIGNATURE });
    const ocr = await extractContacts({ tenant_id: TENANT, source_kind: 'BUSINESS_CARD_OCR', raw: SIGNATURE });
    expect(firstOf(ocr, 'email')!.confidence).toBeLessThan(firstOf(pasted, 'email')!.confidence);
  });
});

describe('extraction never fabricates a field absent from the input (AC3)', () => {
  it('returns no proposals for fields that simply are not there', async () => {
    const r = await extractContacts({
      tenant_id: TENANT,
      source_kind: 'SMART_PASTE',
      raw: 'hello there',
    });
    expect(fields(r)).not.toContain('email');
    expect(fields(r)).not.toContain('phone');
  });

  it('drops a backend proposal whose value is not in its evidence span', async () => {
    const rogue = {
      kind: 'SMART_PASTE' as const,
      extract: () => [
        {
          index: 0,
          proposals: [
            {
              field: 'organization',
              value: 'Globex Corporation',
              confidence: 0.9,
              evidence: { start: 0, end: 5, snippet: 'hello' },
              origin: 'local' as const,
            },
          ],
        },
      ],
    };
    const original = getContactBackend('SMART_PASTE');
    const { setContactBackend } = await import('../src/services/contactBackends');
    setContactBackend('SMART_PASTE', rogue);
    try {
      const r = await extractContacts({ tenant_id: TENANT, source_kind: 'SMART_PASTE', raw: 'hello world' });
      expect(fields(r)).not.toContain('organization');
      expect(r.rejected).toHaveLength(1);
      expect(r.rejected[0].reason).toMatch(/does not appear in its evidence span/);
    } finally {
      setContactBackend('SMART_PASTE', original);
    }
  });

  it('drops a HALLUCINATED LLM field and reports it', async () => {
    setContactLlmAdjunct(async () => [
      {
        field: 'organization',
        value: 'Initech Global Holdings',
        confidence: 0.9,
        evidence: { start: 0, end: 5, snippet: 'hello' },
        origin: 'llm',
      },
    ]);
    const r = await extractContacts({
      tenant_id: TENANT,
      source_kind: 'SMART_PASTE',
      raw: 'hello world jane@x.com',
      allow_llm: true,
      required_fields: ['organization'],
    });
    // The model answered; the guard removed it because the input does not support it.
    expect(r.llm_invoked).toBe(true);
    expect(fields(r)).not.toContain('organization');
    expect(r.rejected.some((x) => x.origin === 'llm')).toBe(true);
    expect(r.unresolved_required).toContain('organization');
  });

  it('keeps an LLM field that IS supported by the input', async () => {
    const raw = 'Contact: Globex Corporation, jane@globex.com';
    setContactLlmAdjunct(async () => [
      {
        field: 'organization',
        value: 'Globex Corporation',
        confidence: 0.8,
        evidence: { start: raw.indexOf('Globex'), end: raw.indexOf('Globex') + 'Globex Corporation'.length, snippet: 'Globex Corporation' },
        origin: 'llm',
      },
    ]);
    const r = await extractContacts({
      tenant_id: TENANT,
      source_kind: 'SMART_PASTE',
      raw,
      allow_llm: true,
      required_fields: ['organization'],
    });
    expect(fields(r)).toContain('organization');
    expect(r.rejected).toHaveLength(0);
  });

  it('rejects an out-of-range span rather than trusting the offsets', () => {
    const bad: FieldProposal = {
      field: 'email', value: 'a@b.com', confidence: 1,
      evidence: { start: 0, end: 9999, snippet: '' }, origin: 'local',
    };
    const v = verifyEvidence('short', bad);
    expect(v.ok).toBe(false);
  });
});

describe('local parser runs before any LLM call and the LLM is opt-in (AC1)', () => {
  it('never calls the model when the caller did not opt in', async () => {
    const spy = vi.fn(async () => []);
    setContactLlmAdjunct(spy);
    const r = await extractContacts({
      tenant_id: TENANT,
      source_kind: 'SMART_PASTE',
      raw: 'no contact details here',
      required_fields: ['email'],
      // allow_llm omitted — the default must be off
    });
    expect(spy).not.toHaveBeenCalled();
    expect(r.llm_invoked).toBe(false);
    expect(r.llm_reason).toMatch(/did not opt in/);
  });

  it('does not call the model even when opted in, if local already resolved everything', async () => {
    const spy = vi.fn(async () => []);
    setContactLlmAdjunct(spy);
    const r = await extractContacts({
      tenant_id: TENANT,
      source_kind: 'EMAIL_SIGNATURE',
      raw: SIGNATURE,
      allow_llm: true,
      required_fields: ['email', 'phone'],
    });
    expect(spy).not.toHaveBeenCalled();
    expect(r.llm_invoked).toBe(false);
    expect(r.llm_reason).toMatch(/not needed/);
  });

  it('calls the model only for the fields the local pass could not resolve', async () => {
    const spy = vi.fn(async () => []);
    setContactLlmAdjunct(spy);
    await extractContacts({
      tenant_id: TENANT,
      source_kind: 'SMART_PASTE',
      raw: 'jane@acme.com',
      allow_llm: true,
      required_fields: ['email', 'job_title'],
    });
    expect(spy).toHaveBeenCalledTimes(1);
    // email was already found locally, so it must not be re-requested.
    expect(spy.mock.calls[0][0].missing_fields).toEqual(['job_title']);
  });

  it('a failing adjunct degrades to the local result instead of failing the call', async () => {
    setContactLlmAdjunct(async () => { throw new Error('gateway 503'); });
    const r = await extractContacts({
      tenant_id: TENANT,
      source_kind: 'SMART_PASTE',
      raw: 'jane@acme.com',
      allow_llm: true,
      required_fields: ['email', 'organization'],
    });
    expect(fields(r)).toContain('email');
    expect(r.llm_reason).toMatch(/adjunct failed/);
  });

  it('says so when the adjunct was asked for but never wired', async () => {
    setContactLlmAdjunct(null);
    const r = await extractContacts({
      tenant_id: TENANT, source_kind: 'SMART_PASTE', raw: 'nothing',
      allow_llm: true, required_fields: ['email'],
    });
    expect(r.llm_reason).toMatch(/no adjunct is wired/);
  });

  it('a local proposal is never overwritten by the model', async () => {
    const raw = 'jane@acme.com Acme Ltd';
    setContactLlmAdjunct(async () => [
      { field: 'email', value: 'acme', confidence: 0.9,
        evidence: { start: raw.indexOf('Acme'), end: raw.indexOf('Acme') + 4, snippet: 'Acme' },
        origin: 'llm' },
    ]);
    const r = await extractContacts({
      tenant_id: TENANT, source_kind: 'SMART_PASTE', raw,
      allow_llm: true, required_fields: ['email', 'job_title'],
    });
    const emails = r.candidates.flatMap((c) => c.proposals).filter((p) => p.field === 'email');
    expect(emails.every((e) => e.origin === 'local')).toBe(true);
  });
});

describe('schemas resolve tenant-first with platform fallback (AC4)', () => {
  it('prefers a tenant schema and reports the source', async () => {
    lookupMock.mockResolvedValue({
      taxonomy_version_id: 'ver-tenant',
      tenant_id: TENANT,
      field_definitions: [{ name: 'email', required: true }, { name: 'phone' }],
    });
    const r = await extractContacts({ tenant_id: TENANT, source_kind: 'SMART_PASTE', raw: SIGNATURE });
    expect(r.schema.source).toBe('tenant');
    expect(r.schema.taxonomy_version_id).toBe('ver-tenant');
    expect(r.schema.field_specs.map((f) => f.name)).toEqual(['email', 'phone']);
  });

  it('falls back to the platform schema when the tenant has none', async () => {
    lookupMock.mockResolvedValue({
      taxonomy_version_id: 'ver-platform',
      tenant_id: null,
      field_definitions: [{ name: 'email', required: true }],
    });
    const r = await extractContacts({ tenant_id: TENANT, source_kind: 'SMART_PASTE', raw: SIGNATURE });
    expect(r.schema.source).toBe('platform');
  });

  it('falls back to the builtin when taxonomy has nothing at all', async () => {
    lookupMock.mockResolvedValue(null);
    const r = await extractContacts({ tenant_id: TENANT, source_kind: 'SMART_PASTE', raw: SIGNATURE });
    expect(r.schema.source).toBe('builtin');
    expect(r.schema.field_specs.length).toBeGreaterThan(0);
  });

  it('a taxonomy outage does not take contact capture down', async () => {
    lookupMock.mockRejectedValue(new Error('taxonomy unreachable'));
    const r = await extractContacts({ tenant_id: TENANT, source_kind: 'SMART_PASTE', raw: SIGNATURE });
    expect(r.schema.source).toBe('builtin');
    expect(fields(r)).toContain('email');
  });
});

describe('per-surface backends', () => {
  it('EMAIL_SIGNATURE keeps every handle and qualifies them', async () => {
    const r = await extractContacts({ tenant_id: TENANT, source_kind: 'EMAIL_SIGNATURE', raw: SIGNATURE });
    const all = r.candidates.flatMap((c) => c.proposals);
    expect(all.filter((p) => p.field === 'email')).toHaveLength(2);
    const phones = all.filter((p) => p.field === 'phone');
    expect(phones.length).toBeGreaterThanOrEqual(2);
    expect(phones.map((p) => p.qualifier)).toEqual(expect.arrayContaining(['work', 'mobile']));
  });

  it('EMAIL_SIGNATURE offers an org candidate from the domain, never as the org name', async () => {
    const raw = 'Jane Okonkwo\nEngineer\njane@globex.com';
    const r = await extractContacts({ tenant_id: TENANT, source_kind: 'EMAIL_SIGNATURE', raw });
    const cand = firstOf(r, 'org_candidate');
    expect(cand?.value).toBe('globex.com');
    // A domain is evidence of a company, not its name — it must not be promoted.
    expect(fields(r)).not.toContain('organization');
    expect(cand!.confidence).toBeLessThan(0.5);
  });

  it('VCARD parses declared properties at high confidence', async () => {
    const raw = [
      'BEGIN:VCARD', 'VERSION:3.0', 'FN:Ada Lovelace', 'ORG:Analytical Engines;R&D',
      'TITLE:Chief Mathematician', 'TEL;TYPE=CELL:+44 7700 900999',
      'EMAIL:ada@analytical.example', 'END:VCARD',
    ].join('\n');
    const r = await extractContacts({ tenant_id: TENANT, source_kind: 'VCARD', raw });
    expect(firstOf(r, 'full_name')!.value).toBe('Ada Lovelace');
    expect(firstOf(r, 'organization')!.value).toBe('Analytical Engines');
    expect(firstOf(r, 'phone')!.qualifier).toBe('cell');
    expect(firstOf(r, 'full_name')!.confidence).toBeGreaterThan(0.9);
  });

  it('VCARD_MULTI returns one candidate per card', async () => {
    const card = (n: string, e: string) => `BEGIN:VCARD\nFN:${n}\nEMAIL:${e}\nEND:VCARD`;
    const raw = [card('Ada Lovelace', 'ada@x.example'), card('Alan Turing', 'alan@y.example')].join('\n');
    const r = await extractContacts({ tenant_id: TENANT, source_kind: 'VCARD_MULTI', raw });
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[1].proposals.find((p) => p.field === 'full_name')!.value).toBe('Alan Turing');
  });

  it('a multi-card file handed to VCARD still returns every contact', async () => {
    const card = (n: string) => `BEGIN:VCARD\nFN:${n}\nEND:VCARD`;
    const raw = [card('Ada Lovelace'), card('Alan Turing')].join('\n');
    const r = await extractContacts({ tenant_id: TENANT, source_kind: 'VCARD', raw });
    // Silently discarding the second contact would be data loss.
    expect(r.candidates.length).toBe(2);
  });

  it('MOBILE_CONTACTS reads the structured payload', async () => {
    const structured = [{
      name: 'Grace Hopper',
      emails: [{ value: 'grace@navy.example', label: 'work' }],
      phones: ['+1 202 555 0199'],
      organization: 'Naval Reserve',
    }];
    const r = await extractContacts({
      tenant_id: TENANT, source_kind: 'MOBILE_CONTACTS',
      raw: JSON.stringify(structured), structured,
    });
    expect(firstOf(r, 'full_name')!.value).toBe('Grace Hopper');
    expect(firstOf(r, 'email')!.qualifier).toBe('work');
    expect(r.rejected).toHaveLength(0);
  });

  it('VOICE_TRANSCRIPT reconstructs a spoken address and points at the spoken words', async () => {
    const raw = 'her email is grace at navy dot example and her number is 202 555 0199';
    const r = await extractContacts({ tenant_id: TENANT, source_kind: 'VOICE_TRANSCRIPT', raw });
    const email = firstOf(r, 'email');
    expect(email?.value).toBe('grace@navy.example');
    // Evidence points into the ORIGINAL transcript, not the reconstruction.
    expect(raw.slice(email!.evidence.start, email!.evidence.end)).toMatch(/grace at navy dot example/);
    expect(email!.confidence).toBeLessThan(0.8);
    expect(r.rejected).toHaveLength(0);
  });

  it('despeak is a plain replayable rule', () => {
    expect(despeak('a at b dot com')).toBe('a@b.com');
  });

  it('an unknown source kind names the ones that exist', async () => {
    await expect(
      extractContacts({ tenant_id: TENANT, source_kind: 'TELEPATHY' as never, raw: 'x' }),
    ).rejects.toThrow(/no contact backend registered/);
  });
});

describe('batch extraction', () => {
  it('one malformed item does not lose the rest', async () => {
    const r = await extractContactsBatch({
      tenant_id: TENANT,
      items: [
        { source_kind: 'SMART_PASTE', raw: 'jane@acme.com', id: 'a' },
        { source_kind: 'NOPE' as never, raw: 'x', id: 'b' },
        { source_kind: 'SMART_PASTE', raw: 'bob@acme.com', id: 'c' },
      ],
    });
    expect(r.ok_count).toBe(2);
    expect(r.failed_count).toBe(1);
    expect(r.results.find((x) => x.id === 'b')!.ok).toBe(false);
    expect(r.results.find((x) => x.id === 'c')!.ok).toBe(true);
  });

  it('refuses an empty batch rather than returning a meaningless success', async () => {
    await expect(extractContactsBatch({ tenant_id: TENANT, items: [] })).rejects.toThrow(/non-empty/);
  });
});
