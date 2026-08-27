import {
  TRIGGER_FIELD_TYPES,
  type TriggerCondition,
  type TriggerField,
  type TriggerFrequencyName,
} from '@smartchat/validation';

/**
 * The rule engine.
 *
 * Pure: facts in, a yes or a no out. Nothing here reads a database, a clock or a socket, which is
 * what makes every operator and every awkward case testable without standing anything up.
 */

/**
 * Everything a condition is allowed to see.
 *
 * The gateway assembles one of these per evaluation. A rule can never reach past it, so adding a
 * field to the product does not silently widen what automation can read about a visitor.
 */
export interface TriggerFacts {
  page: {
    url: string | null;
    title: string | null;
    referrer: string | null;
  };
  visitor: {
    country: string | null;
    language: string | null;
    deviceType: string | null;
    isReturning: boolean;
    isIdentified: boolean;
    visitCount: number;
  };
  session: {
    pageViewCount: number;
    secondsOnSite: number;
  };
  agents: {
    available: boolean;
  };
}

type FactValue = string | number | boolean | null;

/** Read one field out of the snapshot. Unknown values come back as null, never as "". */
export function readFact(facts: TriggerFacts, field: TriggerField): FactValue {
  switch (field) {
    case 'page.url':
      return facts.page.url;
    case 'page.title':
      return facts.page.title;
    case 'page.referrer':
      return facts.page.referrer;
    case 'visitor.country':
      return facts.visitor.country;
    case 'visitor.language':
      return facts.visitor.language;
    case 'visitor.deviceType':
      return facts.visitor.deviceType;
    case 'visitor.isReturning':
      return facts.visitor.isReturning;
    case 'visitor.isIdentified':
      return facts.visitor.isIdentified;
    case 'visitor.visitCount':
      return facts.visitor.visitCount;
    case 'session.pageViewCount':
      return facts.session.pageViewCount;
    case 'session.secondsOnSite':
      return facts.session.secondsOnSite;
    case 'agents.available':
      return facts.agents.available;
    default: {
      // Exhaustive: adding a field to TRIGGER_FIELD_TYPES without handling it here fails to
      // compile, rather than silently evaluating to null in production.
      const exhaustive: never = field;
      return exhaustive;
    }
  }
}

/**
 * Evaluate one condition.
 *
 * An unknown fact never matches - not even a negative operator.
 *
 * That asymmetry is deliberate. "URL does not contain /pricing" reads like it should be true when
 * we have no URL, but the honest reading is that we do not know, and a rule that messages people
 * because a fact was missing is worse than one that stays quiet. Absence of information is not
 * evidence. See ADR-035.
 */
export function evaluateCondition(condition: TriggerCondition, facts: TriggerFacts): boolean {
  const actual = readFact(facts, condition.field);
  if (actual === null || actual === undefined) return false;

  const type = TRIGGER_FIELD_TYPES[condition.field];

  if (type === 'boolean') {
    if (typeof actual !== 'boolean') return false;
    return actual === (condition.value === 'true');
  }

  if (type === 'number') {
    const expected = Number(condition.value);
    const value = typeof actual === 'number' ? actual : Number(actual);
    if (!Number.isFinite(expected) || !Number.isFinite(value)) return false;
    switch (condition.operator) {
      case 'eq':
        return value === expected;
      case 'neq':
        return value !== expected;
      case 'gt':
        return value > expected;
      case 'gte':
        return value >= expected;
      case 'lt':
        return value < expected;
      case 'lte':
        return value <= expected;
      default:
        return false;
    }
  }

  // Strings. Compared case-insensitively and trimmed: these are URLs, country codes and language
  // tags, where "/Pricing" and "/pricing" are the same page to everyone except a computer.
  const value = String(actual).trim().toLowerCase();
  const expected = condition.value.trim().toLowerCase();

  switch (condition.operator) {
    case 'equals':
      return value === expected;
    case 'not_equals':
      return value !== expected;
    case 'contains':
      return value.includes(expected);
    case 'not_contains':
      return !value.includes(expected);
    case 'starts_with':
      return value.startsWith(expected);
    case 'ends_with':
      return value.endsWith(expected);
    default:
      return false;
  }
}

/**
 * Evaluate a whole rule.
 *
 * A trigger with no conditions fires on its event alone - that is a legitimate rule ("greet
 * everybody after 30 seconds"), not an empty one, and `all` over an empty set is true anyway.
 */
export function matchesConditions(
  match: 'all' | 'any',
  conditions: readonly TriggerCondition[],
  facts: TriggerFacts,
): boolean {
  if (conditions.length === 0) return true;
  return match === 'all'
    ? conditions.every((condition) => evaluateCondition(condition, facts))
    : conditions.some((condition) => evaluateCondition(condition, facts));
}

/**
 * The value that makes "once per visitor" true rather than best-effort.
 *
 * It becomes `trigger_firings.dedupe_key`, which is half of a unique index - so two gateway
 * processes racing on the same visitor cannot both decide they are first. Null for `every_time`,
 * because Postgres treats nulls in a unique index as distinct, which is exactly the "no cap"
 * semantics we want from the same index.
 */
export function dedupeKeyFor(
  frequency: TriggerFrequencyName,
  identity: { visitorId: string; sessionId: string | null },
): string | null {
  switch (frequency) {
    case 'once_per_visitor':
      return `v:${identity.visitorId}`;
    case 'once_per_session':
      // A visitor with no session id would otherwise share one key across every visit, turning
      // "once per session" into "once ever". Falling back to the visitor is the safe direction:
      // quieter, not chattier.
      return `s:${identity.sessionId ?? identity.visitorId}`;
    case 'every_time':
      return null;
    default: {
      const exhaustive: never = frequency;
      return exhaustive;
    }
  }
}
