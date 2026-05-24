/**
 * AC-7 / AC-8 / AC-10 — ontology v1 bundle authoring + planner shape.
 *
 * Pure functional — no DB. Validates that the three v1 bundles
 * (Healthcare · Realty · Seva) are well-formed and that the goal-keyword
 * tokenization used by the planner can match a bundle's capability_graph
 * SKUs against a typical Intent goal.
 *
 * The full DB-backed registerOntology + plan integration test runs in
 * tests/integration/ once Postgres is online; this file ships first so
 * the bundle authoring is validated on every PR.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { DomainOntologyBundle } from '@projexlight/contracts';

const ONTOLOGIES_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'docs',
  'v3.1',
  'ontologies',
  'v1',
);

function loadBundle(name: string): DomainOntologyBundle {
  const file = path.join(ONTOLOGIES_DIR, `${name}.json`);
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw) as DomainOntologyBundle;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .replace(/[_.]/g, ' ')
      .replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)
      .toLowerCase()
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0),
  );
}

describe('AC-7 · three v1 ontology bundles author cleanly', () => {
  for (const name of ['healthcare', 'realty', 'seva']) {
    it(`${name}.json parses + has the expected shape`, () => {
      const bundle = loadBundle(name);
      expect(bundle.name).toBe(`${name}-v1`);
      expect(bundle.version).toBe('1.0.0');
      expect(Array.isArray(bundle.object_types)).toBe(true);
      expect(bundle.object_types.length).toBeGreaterThan(0);
      expect(Array.isArray(bundle.relation_types)).toBe(true);
      expect(Array.isArray(bundle.capability_graph)).toBe(true);
    });
  }

  it('healthcare bundle covers Patient / Encounter / Prescription / LabResult / Diagnosis', () => {
    const h = loadBundle('healthcare');
    const names = new Set(h.object_types.map((o) => o.name));
    expect(names.has('Patient')).toBe(true);
    expect(names.has('Encounter')).toBe(true);
    expect(names.has('Prescription')).toBe(true);
    expect(names.has('LabResult')).toBe(true);
    expect(names.has('Diagnosis')).toBe(true);
  });

  it('healthcare care-team relation is mapped to ReBAC kind', () => {
    const h = loadBundle('healthcare');
    const careTeam = h.relation_types.find((r) => r.name === 'care-team');
    expect(careTeam).toBeDefined();
    expect(careTeam?.rebac_kind_mapping).toBe('care_team');
  });

  it('every relation_type references object_types that exist in the bundle', () => {
    for (const name of ['healthcare', 'realty', 'seva']) {
      const b = loadBundle(name);
      const objNames = new Set(b.object_types.map((o) => o.name));
      for (const r of b.relation_types) {
        expect(objNames.has(r.from_object_type_name), `${name}: missing ${r.from_object_type_name}`).toBe(true);
        expect(objNames.has(r.to_object_type_name), `${name}: missing ${r.to_object_type_name}`).toBe(true);
      }
    }
  });

  it('every capability_graph entry references an existing object_type and (if specified) relation_type', () => {
    for (const name of ['healthcare', 'realty', 'seva']) {
      const b = loadBundle(name);
      const objNames = new Set(b.object_types.map((o) => o.name));
      const relNames = new Set(b.relation_types.map((r) => r.name));
      for (const c of b.capability_graph) {
        expect(objNames.has(c.object_type_name), `${name}: missing object_type ${c.object_type_name}`).toBe(true);
        if (c.requires_relation_name) {
          expect(relNames.has(c.requires_relation_name), `${name}: missing relation ${c.requires_relation_name}`).toBe(true);
        }
      }
    }
  });
});

describe('AC-8 · Healthcare bundle supports schedule_follow_up_visit goal', () => {
  it('planner-style goal tokenization matches at least 3 capability edges', () => {
    const h = loadBundle('healthcare');
    // Same algorithm sdk-semantic/src/services/planService.ts uses
    // for goal → SKU matching; if this ever drifts, both sides must update.
    const goalTokens = tokenize('schedule_follow_up_visit');
    const matching = h.capability_graph.filter((c) => {
      const skuTokens = tokenize(c.tool_sku.replace(/\./g, ' ').replace(/[-_]/g, ' '));
      // OR check: goal token in SKU tokens, OR post_conditions.advances mentions the goal
      for (const t of goalTokens) {
        if (skuTokens.has(t)) return true;
      }
      const post = JSON.stringify(c.post_conditions ?? {}).toLowerCase();
      for (const t of goalTokens) {
        if (post.includes(t)) return true;
      }
      return false;
    });
    // PRD §7 AC-8: plan must have >=3 valid capability_graph_edge steps.
    expect(matching.length).toBeGreaterThanOrEqual(3);
  });

  it('Patient subject has at least one care-team-gated capability', () => {
    const h = loadBundle('healthcare');
    const patientCaps = h.capability_graph.filter((c) => c.object_type_name === 'Patient');
    const careTeamGated = patientCaps.filter((c) => c.requires_relation_name === 'care-team');
    expect(careTeamGated.length).toBeGreaterThanOrEqual(1);
  });
});

describe('AC-10 · cross-vertical bridge Patient ↔ Person is loadable', () => {
  it('healthcare has Patient + realty has Person + their accessibility fields support care-coordination flag', () => {
    const h = loadBundle('healthcare');
    const r = loadBundle('realty');
    const patient = h.object_types.find((o) => o.name === 'Patient');
    const person = r.object_types.find((o) => o.name === 'Person');
    const property = r.object_types.find((o) => o.name === 'Property');
    expect(patient).toBeDefined();
    expect(person).toBeDefined();
    expect(property).toBeDefined();
    // Person carries mobility_status; Property carries elevator/stairs — the
    // bridge enables an agent to flag care-coordination when (mobility=limited)
    // intersects (stairs_only=true). This test asserts the data is there.
    const personSchema = JSON.stringify(person?.attribute_schema);
    const propertySchema = JSON.stringify(property?.attribute_schema);
    expect(personSchema).toContain('mobility_status');
    expect(propertySchema).toContain('stairs_only');
  });
});
