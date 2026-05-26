import { Blueprint } from '../src/types';

export function validBlueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    id: 'demo-blueprint',
    schema_version: '1.0',
    title: 'Demo Blueprint',
    summary: 'A short, lint-clean fixture used by validator + loader tests.',
    pack: 'general',
    sdks: [
      { name: '@projexlight/sdk-vault', reason: 'demo' },
      { name: '@projexlight/sdk-audit' },
    ],
    clarifying_questions: [
      {
        id: 'demo-q',
        prompt: 'Pick one',
        type: 'enum',
        options: ['a', 'b'],
        default: 'a',
      },
    ],
    outputs: [
      { path: 'src/index.ts', template: 'templates/index.ts.hbs' },
    ],
    estimated_minutes: 5,
    tags: ['demo'],
    ...overrides,
  };
}
