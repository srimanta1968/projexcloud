import { describe, expect, it } from 'vitest';
import { classifyTurn, routerConfig } from '../src/pipeline/turnRouter';

describe('classifyTurn', () => {
  it('sends short exchanges to fast and reasoning, multi-intent, long, upset or agent-flagged turns to complex', () => {
    const d = routerConfig(undefined);
    expect(classifyTurn('Eight thirty please', d)).toEqual({ tier: 'fast', reason: 'default' });
    expect(classifyTurn('Yes that works', d).tier).toBe('fast');
    expect(classifyTurn('Can you explain the difference between the two menus', d)).toEqual({ tier: 'complex', reason: 'reasoning' });
    expect(classifyTurn('What time do you open? And do you take reservations?', d).reason).toBe('multi_intent');
    expect(classifyTurn('This is ridiculous, I want to speak to a manager', d).reason).toBe('frustration');
    expect(classifyTurn(Array(40).fill('word').join(' '), d).reason).toBe('long_turn');
    const custom = routerConfig({ router: { complex_patterns: ['\\ballerg(y|ies|ic)\\b', '(invalid'], max_fast_words: 5 } });
    expect(classifyTurn('Does it contain nut allergies', custom)).toEqual({ tier: 'complex', reason: 'agent_pattern' });
    expect(classifyTurn('one two three four five six', custom).reason).toBe('long_turn');
    expect(classifyTurn('Explain everything', routerConfig({ router: { always: 'fast' } }))).toEqual({ tier: 'fast', reason: 'agent_setting' });
  });
});
