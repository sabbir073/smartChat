import { describe, expect, it } from 'vitest';
import {
  createTriggerSchema,
  expandShortcut,
  triggerConditionSchema,
  type TriggerCondition,
} from '@smartchat/validation';
import { dedupeKeyFor, evaluateCondition, matchesConditions, readFact } from './engine.js';
import type { TriggerFacts } from './engine.js';

function facts(overrides: Partial<TriggerFacts> = {}): TriggerFacts {
  return {
    page: {
      url: 'https://shop.example.com/Pricing?plan=pro',
      title: 'Pricing',
      referrer: 'https://google.com/',
    },
    visitor: {
      country: 'BD',
      language: 'en-GB',
      deviceType: 'desktop',
      isReturning: false,
      isIdentified: false,
      visitCount: 1,
    },
    session: { pageViewCount: 3, secondsOnSite: 45 },
    agents: { available: true },
    ...overrides,
  };
}

const cond = (field: string, operator: string, value: string): TriggerCondition =>
  triggerConditionSchema.parse({ field, operator, value });

describe('readFact', () => {
  it('reads every declared field', () => {
    const f = facts();
    expect(readFact(f, 'page.url')).toBe(f.page.url);
    expect(readFact(f, 'page.title')).toBe('Pricing');
    expect(readFact(f, 'page.referrer')).toBe('https://google.com/');
    expect(readFact(f, 'visitor.country')).toBe('BD');
    expect(readFact(f, 'visitor.language')).toBe('en-GB');
    expect(readFact(f, 'visitor.deviceType')).toBe('desktop');
    expect(readFact(f, 'visitor.isReturning')).toBe(false);
    expect(readFact(f, 'visitor.isIdentified')).toBe(false);
    expect(readFact(f, 'visitor.visitCount')).toBe(1);
    expect(readFact(f, 'session.pageViewCount')).toBe(3);
    expect(readFact(f, 'session.secondsOnSite')).toBe(45);
    expect(readFact(f, 'agents.available')).toBe(true);
  });
});

describe('string operators', () => {
  it('compares case-insensitively, because /Pricing and /pricing are one page', () => {
    expect(evaluateCondition(cond('page.url', 'contains', '/pricing'), facts())).toBe(true);
    expect(evaluateCondition(cond('page.title', 'equals', 'pricing'), facts())).toBe(true);
  });

  it('handles the whole operator set', () => {
    expect(evaluateCondition(cond('visitor.country', 'equals', 'BD'), facts())).toBe(true);
    expect(evaluateCondition(cond('visitor.country', 'not_equals', 'US'), facts())).toBe(true);
    expect(evaluateCondition(cond('visitor.country', 'not_equals', 'BD'), facts())).toBe(false);
    expect(evaluateCondition(cond('page.url', 'not_contains', '/checkout'), facts())).toBe(true);
    expect(evaluateCondition(cond('page.url', 'starts_with', 'https://shop.'), facts())).toBe(true);
    expect(evaluateCondition(cond('page.url', 'ends_with', 'plan=pro'), facts())).toBe(true);
    expect(evaluateCondition(cond('page.url', 'ends_with', '/pricing'), facts())).toBe(false);
  });
});

describe('number operators', () => {
  it('compares numerically rather than as text', () => {
    const f = facts({ session: { pageViewCount: 10, secondsOnSite: 45 } });
    // As strings, "10" < "9". This is the assertion that catches a lexical comparison.
    expect(evaluateCondition(cond('session.pageViewCount', 'gt', '9'), f)).toBe(true);
    expect(evaluateCondition(cond('session.pageViewCount', 'gte', '10'), f)).toBe(true);
    expect(evaluateCondition(cond('session.pageViewCount', 'lt', '10'), f)).toBe(false);
    expect(evaluateCondition(cond('session.pageViewCount', 'lte', '10'), f)).toBe(true);
    expect(evaluateCondition(cond('session.pageViewCount', 'eq', '10'), f)).toBe(true);
    expect(evaluateCondition(cond('session.pageViewCount', 'neq', '10'), f)).toBe(false);
  });

  it('treats zero as a value, not as absence', () => {
    const f = facts({ session: { pageViewCount: 0, secondsOnSite: 0 } });
    expect(evaluateCondition(cond('session.secondsOnSite', 'eq', '0'), f)).toBe(true);
    expect(evaluateCondition(cond('session.secondsOnSite', 'lt', '1'), f)).toBe(true);
  });
});

describe('boolean operators', () => {
  it('matches on both sides of the value', () => {
    expect(evaluateCondition(cond('agents.available', 'is', 'true'), facts())).toBe(true);
    expect(evaluateCondition(cond('agents.available', 'is', 'false'), facts())).toBe(false);

    const offline = facts({ agents: { available: false } });
    expect(evaluateCondition(cond('agents.available', 'is', 'false'), offline)).toBe(true);
  });

  it('treats false as known, not missing', () => {
    const f = facts();
    expect(evaluateCondition(cond('visitor.isReturning', 'is', 'false'), f)).toBe(true);
  });
});

describe('an unknown fact never matches', () => {
  const unknownPage = facts({ page: { url: null, title: null, referrer: null } });

  it('refuses positive operators', () => {
    expect(evaluateCondition(cond('page.url', 'contains', '/pricing'), unknownPage)).toBe(false);
    expect(evaluateCondition(cond('page.url', 'starts_with', 'https://'), unknownPage)).toBe(false);
  });

  it('refuses negative operators too - absence is not evidence', () => {
    // The tempting reading is "we have no URL, so it certainly does not contain /checkout".
    // Acting on that would message people because a fact was missing. See ADR-035.
    expect(evaluateCondition(cond('page.url', 'not_contains', '/checkout'), unknownPage)).toBe(
      false,
    );
    expect(evaluateCondition(cond('page.url', 'not_equals', 'anything'), unknownPage)).toBe(false);
  });
});

describe('matchesConditions', () => {
  it('fires on the event alone when there are no conditions', () => {
    expect(matchesConditions('all', [], facts())).toBe(true);
    expect(matchesConditions('any', [], facts())).toBe(true);
  });

  it('all requires every condition', () => {
    const conditions = [
      cond('page.url', 'contains', '/pricing'),
      cond('agents.available', 'is', 'true'),
    ];
    expect(matchesConditions('all', conditions, facts())).toBe(true);
    expect(matchesConditions('all', conditions, facts({ agents: { available: false } }))).toBe(
      false,
    );
  });

  it('any requires one', () => {
    const conditions = [
      cond('page.url', 'contains', '/checkout'),
      cond('agents.available', 'is', 'true'),
    ];
    expect(matchesConditions('any', conditions, facts())).toBe(true);
    expect(matchesConditions('any', conditions, facts({ agents: { available: false } }))).toBe(
      false,
    );
  });
});

describe('dedupeKeyFor', () => {
  const identity = { visitorId: 'visitor-1', sessionId: 'session-1' };

  it('keys on the visitor, the session, or nothing at all', () => {
    expect(dedupeKeyFor('once_per_visitor', identity)).toBe('v:visitor-1');
    expect(dedupeKeyFor('once_per_session', identity)).toBe('s:session-1');
    expect(dedupeKeyFor('every_time', identity)).toBeNull();
  });

  it('changes with the session, so a second visit can be greeted again', () => {
    const later = { visitorId: 'visitor-1', sessionId: 'session-2' };
    expect(dedupeKeyFor('once_per_session', identity)).not.toBe(
      dedupeKeyFor('once_per_session', later),
    );
    expect(dedupeKeyFor('once_per_visitor', identity)).toBe(dedupeKeyFor('once_per_visitor', later));
  });

  it('falls back to the visitor when there is no session, erring quiet', () => {
    // Sharing one key across visits makes "once per session" behave as "once ever" - which is
    // the direction that under-messages rather than over-messages.
    expect(dedupeKeyFor('once_per_session', { visitorId: 'visitor-1', sessionId: null })).toBe(
      's:visitor-1',
    );
  });
});

describe('the trigger contract refuses rules that would quietly do nothing', () => {
  const base = {
    name: 'Greet',
    event: 'time_on_site',
    afterSeconds: 30,
    actions: [{ type: 'send_message', body: 'Hello' }],
  };

  it('accepts a well-formed rule', () => {
    expect(createTriggerSchema.safeParse(base).success).toBe(true);
  });

  it('refuses an operator the field cannot support', () => {
    const result = triggerConditionSchema.safeParse({
      field: 'session.secondsOnSite',
      operator: 'contains',
      value: '30',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a number field compared against words', () => {
    const result = triggerConditionSchema.safeParse({
      field: 'visitor.visitCount',
      operator: 'gt',
      value: 'many',
    });
    expect(result.success).toBe(false);
  });

  it('refuses a time trigger with no wait, and a wait on any other event', () => {
    expect(createTriggerSchema.safeParse({ ...base, afterSeconds: 0 }).success).toBe(false);
    expect(
      createTriggerSchema.safeParse({ ...base, event: 'page_viewed', afterSeconds: 30 }).success,
    ).toBe(false);
  });

  it('refuses tagging a conversation that the trigger never starts', () => {
    const result = createTriggerSchema.safeParse({
      ...base,
      actions: [{ type: 'add_tag', tag: 'pricing' }],
    });
    expect(result.success).toBe(false);

    // The same actions are fine once the trigger also opens the conversation.
    expect(
      createTriggerSchema.safeParse({
        ...base,
        actions: [
          { type: 'send_message', body: 'Hello' },
          { type: 'add_tag', tag: 'pricing' },
        ],
      }).success,
    ).toBe(true);

    // And fine on their own once a conversation is guaranteed to exist.
    expect(
      createTriggerSchema.safeParse({
        ...base,
        event: 'conversation_started',
        afterSeconds: 0,
        actions: [{ type: 'add_tag', tag: 'pricing' }],
      }).success,
    ).toBe(true);
  });

  it('refuses the same action twice', () => {
    const result = createTriggerSchema.safeParse({
      ...base,
      actions: [
        { type: 'send_message', body: 'Hello' },
        { type: 'send_message', body: 'Hello again' },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a rule with no actions at all', () => {
    expect(createTriggerSchema.safeParse({ ...base, actions: [] }).success).toBe(false);
  });
});

describe('expandShortcut', () => {
  const values = { 'visitor.name': 'Mahedi', 'agent.name': 'Sara', 'visitor.email': null };

  it('substitutes what it knows', () => {
    expect(expandShortcut('Hi {{visitor.name}}, this is {{agent.name}}.', values)).toBe(
      'Hi Mahedi, this is Sara.',
    );
  });

  it('leaves what it does not know visible, rather than blanking it', () => {
    // An agent who can see "{{visitor.email}}" in the box will fix it before sending. One who
    // sees "We will write to ." will not.
    expect(expandShortcut('We will write to {{visitor.email}}.', values)).toBe(
      'We will write to {{visitor.email}}.',
    );
    expect(expandShortcut('Your {{order.id}} is ready', values)).toBe('Your {{order.id}} is ready');
  });

  it('tolerates spacing inside the braces', () => {
    expect(expandShortcut('Hi {{ visitor.name }}', values)).toBe('Hi Mahedi');
  });
});
