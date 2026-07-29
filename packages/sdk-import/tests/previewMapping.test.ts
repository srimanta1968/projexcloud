/**
 * Preview + mapping-assistant unit tests (P16 · EP-375 · PCF-02-2).
 *
 * Both services are pure, so these run everywhere with no database and no
 * network — which is what lets them assert the rules that matter most:
 * suggestions are never auto-applied, and an address never becomes a person
 * column.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { buildPreview, splitLine } from '../src/services/previewService';
import {
  suggestMapping,
  confirmMapping,
  confirmedMappings,
  setMappingAssistant,
  UnknownMappingColumn,
  UnknownMappingTarget,
} from '../src/services/mappingAssistantService';
import { CANONICAL_TARGETS, PLACE_TARGETS } from '../src/models/import.model';

const CSV = [
  'first_name,last_name,email,phone,street_address,city,postal_code,country,external_id,notes',
  'Ada,Lovelace,ada@example.test,+44 20 7946 0958,1 Analytical Way,London,NW1 6XE,GB,CRM-001,first',
  'Alan,Turing,alan@example.test,+44 161 496 0000,2 Bombe Road,Manchester,M1 2AB,GB,CRM-002,second',
  'Grace,Hopper,grace@example.test,+1 202 555 0143,3 Compiler Street,Arlington,22201,US,CRM-003,third',
].join('\n');

afterEach(() => setMappingAssistant(null));

describe('previewService', () => {
  it('splits quoted fields containing the delimiter', () => {
    expect(splitLine('a,"b,c",d', ',')).toEqual(['a', 'b,c', 'd']);
    expect(splitLine('a,"say ""hi""",c', ',')).toEqual(['a', 'say "hi"', 'c']);
  });

  it('detects delimiter, header row, column types and row count', () => {
    const p = buildPreview({ content: CSV });
    expect(p.delimiter).toBe(',');
    expect(p.delimiter_confidence).toBeGreaterThan(0.7);
    expect(p.has_header_row).toBe(true);
    expect(p.row_count).toBe(3);
    expect(p.columns).toHaveLength(10);

    const byName = Object.fromEntries(p.columns.map((c) => [c.name, c]));
    expect(byName.email.detected_type).toBe('email');
    expect(byName.phone.detected_type).toBe('phone');
    expect(byName.country.detected_type).toBe('country');
    expect(byName.email.type_confidence).toBe(1);
  });

  it('prefers the delimiter that splits every line consistently, not the most frequent one', () => {
    // Commas appear far more often, but only the pipe yields a consistent shape.
    const content = [
      'name|note',
      'Ada|one, two, three, four, five',
      'Alan|six, seven, eight, nine',
    ].join('\n');
    expect(buildPreview({ content }).delimiter).toBe('|');
  });

  it('flags sensitive columns for tokenization and redacts their samples', () => {
    const p = buildPreview({ content: CSV });
    const byName = Object.fromEntries(p.columns.map((c) => [c.name, c]));

    expect(byName.email.sensitivity).toBe('contact_point');
    expect(byName.phone.sensitivity).toBe('contact_point');
    expect(byName.street_address.sensitivity).toBe('location');
    expect(byName.first_name.sensitivity).toBe('direct_identifier');
    expect(byName.notes.sensitivity).toBe('none');

    for (const name of ['email', 'phone', 'street_address', 'first_name']) {
      expect(byName[name].tokenize_at_ingress).toBe(true);
      expect(byName[name].sample_values.every((v) => v === '[redacted]')).toBe(true);
    }
    // A preview travels into UIs, logs and tickets — no identifier may ride along.
    expect(JSON.stringify(p)).not.toContain('ada@example.test');
    // Non-sensitive columns keep real samples, which is what makes a preview useful.
    expect(byName.notes.sample_values).toContain('first');
  });

  it('detects the source system identifier and says it becomes a crosswalk', () => {
    const p = buildPreview({ content: CSV });
    const byName = Object.fromEntries(p.columns.map((c) => [c.name, c]));
    expect(byName.external_id.is_source_id).toBe(true);
    expect(byName.email.is_source_id).toBe(false);
    expect(p.warnings.join(' ')).toMatch(/never replaced by platform ids/);
  });

  it('detects an unnamed uuid identifier column from its values alone', () => {
    const content = [
      'ref,label',
      '3f2504e0-4f89-41d3-9a0c-0305e82c3301,a',
      '3f2504e0-4f89-41d3-9a0c-0305e82c3302,b',
    ].join('\n');
    const p = buildPreview({ content });
    expect(p.columns[0].detected_type).toBe('uuid');
    expect(p.columns[0].is_source_id).toBe(true);
  });

  it('reports a mixed column rather than forcing a type onto it', () => {
    const content = ['value', '1', '2', 'not a number', 'nor this'].join('\n');
    const p = buildPreview({ content });
    expect(p.columns[0].detected_type).toBe('mixed');
    expect(p.columns[0].type_confidence).toBeLessThan(0.8);
  });

  it('warns instead of guessing when there is no header row', () => {
    const content = ['1,2,3', '4,5,6'].join('\n');
    const p = buildPreview({ content });
    expect(p.has_header_row).toBe(false);
    expect(p.columns.map((c) => c.name)).toEqual(['column_1', 'column_2', 'column_3']);
    expect(p.warnings.join(' ')).toMatch(/no header row detected/);
  });

  it('warns about ragged rows that will land in the exception file', () => {
    const content = ['a,b,c', '1,2,3', '4,5'].join('\n');
    expect(buildPreview({ content }).warnings.join(' ')).toMatch(/exception file/);
  });

  it('warns when the content was decoded with the wrong charset', () => {
    const p = buildPreview({ content: 'name\nAda�' });
    expect(p.encoding).toBe('unknown');
    expect(p.warnings.join(' ')).toMatch(/replacement characters/);
  });

  it('handles an empty source without throwing', () => {
    const p = buildPreview({ content: '   \n\n' });
    expect(p.row_count).toBe(0);
    expect(p.columns).toEqual([]);
    expect(p.warnings.join(' ')).toMatch(/no non-empty lines/);
  });
});

describe('mappingAssistantService', () => {
  it('gives every suggestion a confidence and a non-empty reason', async () => {
    const s = await suggestMapping(buildPreview({ content: CSV }), { tenant_id: 't' });
    expect(s).toHaveLength(10);
    for (const m of s) {
      expect(typeof m.confidence).toBe('number');
      expect(m.confidence).toBeGreaterThanOrEqual(0);
      expect(m.confidence).toBeLessThanOrEqual(1);
      expect(m.reason.length).toBeGreaterThan(0);
    }
  });

  it('auto-applies nothing — every suggestion comes back unconfirmed', async () => {
    const s = await suggestMapping(buildPreview({ content: CSV }), { tenant_id: 't' });
    expect(s.every((m) => m.confirmed === false)).toBe(true);
    // And an unconfirmed mapping is invisible to the commit path.
    const map = confirmMapping(s, [], CANONICAL_TARGETS);
    expect(confirmedMappings(map)).toEqual([]);
  });

  it('maps an address to a place plus a relationship, never to a person column', async () => {
    const s = await suggestMapping(buildPreview({ content: CSV }), { tenant_id: 't' });
    const byColumn = Object.fromEntries(s.map((m) => [m.source_column, m]));

    for (const col of ['street_address', 'city', 'postal_code', 'country']) {
      expect(PLACE_TARGETS).toContain(byColumn[col].target);
      expect(byColumn[col].target.startsWith('person.')).toBe(false);
      expect(byColumn[col].relationship).toBeTruthy();
      expect(byColumn[col].relationship?.object_kind).toBe('place');
      expect(byColumn[col].relationship?.predicate).toBe('located_at');
    }
    // Non-place targets carry no relationship hint.
    expect(byColumn.email.relationship).toBeNull();
  });

  it('routes the source identifier to a crosswalk carrying the issuing system', async () => {
    const s = await suggestMapping(buildPreview({ content: CSV }), {
      tenant_id: 't',
      source_system: 'partner-extract',
    });
    const ext = s.find((m) => m.source_column === 'external_id')!;
    expect(ext.target).toBe('external.id');
    expect(ext.crosswalk?.external_system).toBe('partner-extract');
    expect(ext.reason).toMatch(/never replaced by a platform id/);
  });

  it('leaves an unrecognised column unmapped at zero confidence rather than guessing', async () => {
    const s = await suggestMapping(buildPreview({ content: CSV }), { tenant_id: 't' });
    const notes = s.find((m) => m.source_column === 'notes')!;
    expect(notes.target).toBe('unmapped');
    expect(notes.confidence).toBe(0);
    expect(notes.alternatives.some((a) => a.target === 'attribute.custom')).toBe(true);
  });

  it('sends the assistant no raw values from a sensitive column', async () => {
    let seen: unknown;
    setMappingAssistant(async (req) => {
      seen = req;
      return [];
    });
    await suggestMapping(buildPreview({ content: CSV }), { tenant_id: 't' });
    const payload = JSON.stringify(seen);
    expect(payload).not.toContain('ada@example.test');
    expect(payload).not.toContain('+44 20 7946 0958');
    expect(payload).not.toContain('1 Analytical Way');
    // Column names and types DO go, because that is what a suggestion needs.
    expect(payload).toContain('street_address');
    expect(payload).toContain('email');
  });

  it('lets the assistant override only when it beats the deterministic match', async () => {
    setMappingAssistant(async () => [
      // Lower confidence than the exact-name match for email -> ignored.
      { source_column: 'email', target: 'contact.handle', confidence: 0.3, reason: 'looks like a handle' },
      // Higher than the unmapped fallback for notes -> accepted.
      { source_column: 'notes', target: 'attribute.custom', confidence: 0.6, reason: 'free text worth keeping' },
    ]);
    const s = await suggestMapping(buildPreview({ content: CSV }), { tenant_id: 't' });
    const byColumn = Object.fromEntries(s.map((m) => [m.source_column, m]));

    expect(byColumn.email.target).toBe('contact.email');
    expect(byColumn.email.proposed_by).toBe('heuristic');

    expect(byColumn.notes.target).toBe('attribute.custom');
    expect(byColumn.notes.proposed_by).toBe('assistant');
    // A reviewer can always tell a model's suggestion from a rule's.
    expect(byColumn.notes.reason.startsWith('assistant:')).toBe(true);
    expect(byColumn.notes.confirmed).toBe(false);
  });

  it('falls back to deterministic suggestions when the assistant fails', async () => {
    setMappingAssistant(async () => {
      throw new Error('budget exceeded');
    });
    const s = await suggestMapping(buildPreview({ content: CSV }), { tenant_id: 't' });
    expect(s.find((m) => m.source_column === 'email')!.target).toBe('contact.email');
  });

  it('confirms only the columns a human named', async () => {
    const s = await suggestMapping(buildPreview({ content: CSV }), { tenant_id: 't' });
    const map = confirmMapping(
      s,
      [
        { source_column: 'email', target: 'contact.email', confirmed_by: 'reviewer@example.test' },
        { source_column: 'notes', target: 'attribute.custom', confirmed_by: 'reviewer@example.test' },
      ],
      CANONICAL_TARGETS,
    );

    expect(map.email.confirmed).toBe(true);
    expect(map.email.confirmed_by).toBe('reviewer@example.test');
    expect(map.notes.confirmed).toBe(true);
    // Everything the reviewer did not touch stays inert.
    expect(map.first_name.confirmed).toBe(false);
    expect(confirmedMappings(map).map((m) => m.source_column).sort()).toEqual(['email', 'notes']);
  });

  it('records an override as a human decision and keeps what the assistant had proposed', async () => {
    const s = await suggestMapping(buildPreview({ content: CSV }), { tenant_id: 't' });
    const map = confirmMapping(
      s,
      [{ source_column: 'city', target: 'place.region', confirmed_by: 'reviewer@example.test' }],
      CANONICAL_TARGETS,
    );
    expect(map.city.target).toBe('place.region');
    expect(map.city.proposed_by).toBe('human');
    expect(map.city.confidence).toBe(1);
    expect(map.city.reason).toMatch(/overridden by reviewer@example.test/);
    expect(map.city.reason).toMatch(/place\.locality/);
    // Still a place, so the relationship follows the new target.
    expect(map.city.relationship?.object_kind).toBe('place');
  });

  it('rejects a confirmation for an unknown column or an unknown target', async () => {
    const s = await suggestMapping(buildPreview({ content: CSV }), { tenant_id: 't' });
    expect(() =>
      confirmMapping(s, [{ source_column: 'nope', target: 'contact.email', confirmed_by: 'r' }], CANONICAL_TARGETS),
    ).toThrow(UnknownMappingColumn);
    expect(() =>
      confirmMapping(
        s,
        [{ source_column: 'email', target: 'person.shoe_size' as never, confirmed_by: 'r' }],
        CANONICAL_TARGETS,
      ),
    ).toThrow(UnknownMappingTarget);
  });
});
