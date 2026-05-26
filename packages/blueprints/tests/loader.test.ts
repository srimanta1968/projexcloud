import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadBlueprint, listBlueprints } from '../src/loader';

function writeYaml(dir: string, content: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'blueprint.yaml');
  writeFileSync(p, content);
  return p;
}

const GOOD_YAML = `
id: my-bp
schema_version: "1.0"
title: My Blueprint
summary: A YAML fixture used by loader tests; long enough to be meaningful.
pack: general
sdks:
  - name: "@projexlight/sdk-vault"
outputs:
  - path: src/index.ts
    template: templates/index.ts.hbs
estimated_minutes: 5
`.trim();

describe('loadBlueprint', () => {
  it('loads + validates a YAML blueprint', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-load-'));
    writeYaml(dir, GOOD_YAML);
    const r = loadBlueprint({ dir });
    expect(r.blueprint.id).toBe('my-bp');
    expect(r.dir).toBe(dir);
  });

  it('loads JSON when blueprint.json exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-load-json-'));
    writeFileSync(join(dir, 'blueprint.json'), JSON.stringify({
      id: 'json-bp',
      schema_version: '1.0',
      title: 'JSON',
      summary: 'json fixture',
      pack: 'general',
      sdks: [{ name: '@projexlight/sdk-vault' }],
      outputs: [{ path: 'a', template: 'b' }],
      estimated_minutes: 3,
    }));
    const r = loadBlueprint({ dir });
    expect(r.blueprint.id).toBe('json-bp');
  });

  it('errors when no manifest in dir', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-load-empty-'));
    expect(() => loadBlueprint({ dir })).toThrow(/No blueprint manifest found/);
  });

  it('surfaces YAML parse errors with file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-load-bad-yaml-'));
    writeYaml(dir, '{not: valid yaml: at all]');
    expect(() => loadBlueprint({ dir })).toThrow(/Failed to parse/);
  });

  it('surfaces validation errors with file path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bp-load-bad-bp-'));
    writeYaml(dir, 'id: BAD_ID\nschema_version: "1.0"\ntitle: t\nsummary: s\npack: general\nsdks: []\noutputs: []\nestimated_minutes: 1');
    expect(() => loadBlueprint({ dir })).toThrow(/failed validation/);
  });
});

describe('listBlueprints', () => {
  it('returns empty list when root does not exist', () => {
    expect(listBlueprints('/non/existent/path')).toEqual([]);
  });

  it('walks one level deep and skips dirs without a manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'bp-list-'));
    writeYaml(join(root, 'one'), GOOD_YAML);
    writeYaml(join(root, 'two'), GOOD_YAML.replace('my-bp', 'second'));
    mkdirSync(join(root, 'three-no-manifest'));

    const blueprints = listBlueprints(root);
    expect(blueprints.length).toBe(2);
    expect(blueprints.map((b) => b.blueprint.id).sort()).toEqual(['my-bp', 'second']);
  });

  it('silently skips invalid blueprints (so list never blows up)', () => {
    const root = mkdtempSync(join(tmpdir(), 'bp-list-mixed-'));
    writeYaml(join(root, 'good'), GOOD_YAML);
    writeYaml(join(root, 'bad'), 'id: BAD!!\nschema_version: "1.0"\ntitle: t\nsummary: s\npack: general\nsdks: []\noutputs: []\nestimated_minutes: 1');

    const blueprints = listBlueprints(root);
    expect(blueprints.length).toBe(1);
    expect(blueprints[0].blueprint.id).toBe('my-bp');
  });

  it('returns blueprints sorted by id', () => {
    const root = mkdtempSync(join(tmpdir(), 'bp-list-sort-'));
    writeYaml(join(root, 'one'), GOOD_YAML.replace('my-bp', 'zebra'));
    writeYaml(join(root, 'two'), GOOD_YAML.replace('my-bp', 'alpha'));
    writeYaml(join(root, 'three'), GOOD_YAML.replace('my-bp', 'mango'));

    const blueprints = listBlueprints(root);
    expect(blueprints.map((b) => b.blueprint.id)).toEqual(['alpha', 'mango', 'zebra']);
  });
});

describe('real pilot blueprint loads', () => {
  it('packages/../blueprints/revops-crm/blueprint.yaml validates clean', () => {
    const dir = join(__dirname, '..', '..', '..', 'blueprints', 'revops-crm');
    const r = loadBlueprint({ dir });
    expect(r.blueprint.id).toBe('revops-crm');
    expect(r.blueprint.pack).toBe('general');
    expect(r.blueprint.sdks.length).toBe(5);
    expect(r.blueprint.clarifying_questions.length).toBe(3);
  });
});
