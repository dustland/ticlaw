import { beforeEach, describe, expect, it } from 'vitest';
import { _initTestDatabase, getMindState } from './db.js';
import {
  createPackage,
  listPackages,
  lockMind,
  recordUserInteraction,
  rollbackPackage,
  unlockMind,
} from './mind.js';

describe('mind core', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('updates persona on natural persona instruction', () => {
    const result = recordUserInteraction({
      chat_jid: 'dc:test',
      role: 'user',
      content: '你活泼一点，回答简短',
      timestamp: new Date().toISOString(),
    });

    expect(result.intent).toBe('persona');
    const state = getMindState();
    expect(state.persona.tone).toBe('playful');
    expect(state.persona.verbosity).toBe('short');
  });

  it('does not update persona when locked', () => {
    lockMind();
    recordUserInteraction({
      chat_jid: 'dc:test',
      role: 'user',
      content: '你活泼一点',
      timestamp: new Date().toISOString(),
    });

    const state = getMindState();
    expect(state.lifecycle).toBe('locked');
    expect(state.persona.tone).not.toBe('playful');

    unlockMind();
    recordUserInteraction({
      chat_jid: 'dc:test',
      role: 'user',
      content: '你活泼一点',
      timestamp: new Date().toISOString(),
    });
    expect(getMindState().persona.tone).toBe('playful');
  });

  it('creates and rollbacks packages', () => {
    const p1 = createPackage('first');
    const p2 = createPackage('second');
    expect(p2.version).toBeGreaterThan(p1.version);
    expect(listPackages(10).length).toBeGreaterThanOrEqual(2);

    const rolled = rollbackPackage(p1.version);
    expect(rolled?.version).toBe(p1.version);
  });
});
