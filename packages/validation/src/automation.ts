import { z } from 'zod';
import { uuidSchema } from './common.js';

/**
 * The automation contract.
 *
 * Conditions and actions live in JSON columns, so this file is the only thing standing between a
 * stored rule and the engine that executes it. Everything is parsed on write *and* on read: a rule
 * written by a future release that this one cannot understand is refused at evaluation rather than
 * executed halfway.
 */

// ---------------------------------------------------------------------------
// Facts a condition can read
// ---------------------------------------------------------------------------

/**
 * Every field a condition may name, and the kind of value it holds.
 *
 * A closed list rather than an open path expression: the engine reads a snapshot the gateway
 * builds, and a rule that could name an arbitrary path would be able to reach data the snapshot was
 * never meant to expose.
 */
export const TRIGGER_FIELD_TYPES = {
  'page.url': 'string',
  'page.title': 'string',
  'page.referrer': 'string',
  'visitor.country': 'string',
  'visitor.language': 'string',
  'visitor.deviceType': 'string',
  'visitor.isReturning': 'boolean',
  'visitor.isIdentified': 'boolean',
  'visitor.visitCount': 'number',
  'session.pageViewCount': 'number',
  'session.secondsOnSite': 'number',
  'agents.available': 'boolean',
} as const;

export type TriggerField = keyof typeof TRIGGER_FIELD_TYPES;
export type TriggerFieldType = (typeof TRIGGER_FIELD_TYPES)[TriggerField];

export const TRIGGER_FIELDS = Object.keys(TRIGGER_FIELD_TYPES) as TriggerField[];

export const STRING_OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'starts_with',
  'ends_with',
] as const;

export const NUMBER_OPERATORS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte'] as const;

export const BOOLEAN_OPERATORS = ['is'] as const;

export const OPERATORS_BY_TYPE: Readonly<Record<TriggerFieldType, readonly string[]>> = {
  string: STRING_OPERATORS,
  number: NUMBER_OPERATORS,
  boolean: BOOLEAN_OPERATORS,
};

export const triggerOperatorSchema = z.enum([
  ...STRING_OPERATORS,
  ...NUMBER_OPERATORS,
  ...BOOLEAN_OPERATORS,
]);

export type TriggerOperator = z.infer<typeof triggerOperatorSchema>;

/**
 * One condition.
 *
 * `value` is always a string, whatever the field's type. Numbers and booleans are parsed here, at
 * the boundary, so the stored JSON has one shape and a hand-edited row cannot smuggle an object
 * into a comparison.
 */
export const triggerConditionSchema = z
  .object({
    field: z.enum(TRIGGER_FIELDS as [TriggerField, ...TriggerField[]]),
    operator: triggerOperatorSchema,
    value: z.string().trim().min(1).max(300),
  })
  .superRefine((condition, ctx) => {
    const type = TRIGGER_FIELD_TYPES[condition.field];
    if (!OPERATORS_BY_TYPE[type].includes(condition.operator)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['operator'],
        message: `"${condition.operator}" cannot be used on ${condition.field}, which holds a ${type}`,
      });
      return;
    }
    if (type === 'number' && !Number.isFinite(Number(condition.value))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `${condition.field} needs a number`,
      });
    }
    if (type === 'boolean' && condition.value !== 'true' && condition.value !== 'false') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['value'],
        message: `${condition.field} needs true or false`,
      });
    }
  });

export type TriggerCondition = z.infer<typeof triggerConditionSchema>;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const triggerActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('send_message'),
    /** Sent as the account's bot sender, attributed with the widget's configured display name. */
    body: z.string().trim().min(1).max(1000),
  }),
  z.object({
    type: z.literal('add_tag'),
    tag: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9][a-z0-9 _-]*$/i, 'Tags are letters, numbers, spaces, hyphens and underscores'),
  }),
  z.object({
    type: z.literal('set_priority'),
    priority: z.enum(['low', 'normal', 'high', 'urgent']),
  }),
  z.object({
    type: z.literal('route_to_department'),
    departmentId: uuidSchema,
  }),
]);

export type TriggerAction = z.infer<typeof triggerActionSchema>;
export type TriggerActionType = TriggerAction['type'];

/** Actions that can only be applied to a conversation that already exists. */
export const CONVERSATION_SCOPED_ACTIONS: readonly TriggerActionType[] = [
  'add_tag',
  'set_priority',
  'route_to_department',
];

export const triggerEventSchema = z.enum([
  'visitor_arrived',
  'page_viewed',
  'time_on_site',
  'conversation_started',
]);

export type TriggerEventName = z.infer<typeof triggerEventSchema>;

/** Events that happen before the visitor has said anything, so there may be no conversation yet. */
export const PRE_CONVERSATION_EVENTS: readonly TriggerEventName[] = [
  'visitor_arrived',
  'page_viewed',
  'time_on_site',
];

export const triggerMatchSchema = z.enum(['all', 'any']);
export const triggerFrequencySchema = z.enum([
  'once_per_session',
  'once_per_visitor',
  'every_time',
]);

export type TriggerFrequencyName = z.infer<typeof triggerFrequencySchema>;

const triggerBodySchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).nullable().default(null),
  /** Null means every website in the account. */
  propertyId: uuidSchema.nullable().default(null),
  event: triggerEventSchema,
  enabled: z.boolean().default(true),
  match: triggerMatchSchema.default('all'),
  conditions: z.array(triggerConditionSchema).max(10).default([]),
  actions: z.array(triggerActionSchema).min(1).max(4),
  frequency: triggerFrequencySchema.default('once_per_session'),
  cooldownSeconds: z.number().int().min(30).max(86_400).default(60),
  afterSeconds: z.number().int().min(0).max(3_600).default(0),
  position: z.number().int().min(0).max(999).default(0),
});

/**
 * Cross-field rules.
 *
 * Each of these exists to stop a rule that would be stored happily and then quietly do nothing -
 * the most expensive kind of automation bug, because the person who wrote it believes it works.
 */
function refineTrigger(
  value: {
    event: TriggerEventName;
    actions: TriggerAction[];
    afterSeconds: number;
  },
  ctx: z.RefinementCtx,
): void {
  const types = value.actions.map((action) => action.type);

  if (new Set(types).size !== types.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actions'],
      message: 'Each kind of action can only appear once in a trigger',
    });
  }

  if (value.event === 'time_on_site' && value.afterSeconds < 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['afterSeconds'],
      message: 'A time-on-site trigger needs to know how long to wait',
    });
  }

  if (value.event !== 'time_on_site' && value.afterSeconds !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['afterSeconds'],
      message: 'Only a time-on-site trigger waits; this one fires when its event happens',
    });
  }

  // Tagging, prioritising and routing all need a conversation. Before the visitor has written
  // anything there may not be one, so the trigger has to be the thing that starts it.
  if (
    PRE_CONVERSATION_EVENTS.includes(value.event) &&
    types.some((type) => CONVERSATION_SCOPED_ACTIONS.includes(type)) &&
    !types.includes('send_message')
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['actions'],
      message:
        'This event can happen before a conversation exists, so add a message to start one - tagging, priority and routing need something to apply to',
    });
  }
}

export const createTriggerSchema = triggerBodySchema.superRefine(refineTrigger);

/**
 * A partial update still has to satisfy the cross-field rules, so the service merges it into the
 * stored trigger and re-parses the whole thing with `createTriggerSchema`. This schema only checks
 * the shape of what was sent.
 */
export const updateTriggerSchema = triggerBodySchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'Nothing to update',
);

export type CreateTriggerInput = z.infer<typeof createTriggerSchema>;
export type UpdateTriggerInput = z.infer<typeof updateTriggerSchema>;

/** Parse conditions and actions coming back out of the database. */
export const storedConditionsSchema = z.array(triggerConditionSchema).catch([]);
export const storedActionsSchema = z.array(triggerActionSchema).catch([]);

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

/**
 * The token typed after "/".
 *
 * Lowercase, no spaces: it is matched against what an agent types mid-sentence, and a shortcut key
 * with a space in it could never be recognised as one word.
 */
export const shortcutKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use lowercase letters, numbers, hyphens and underscores');

export const createShortcutSchema = z.object({
  key: shortcutKeySchema,
  title: z.string().trim().min(1).max(80),
  body: z.string().trim().min(1).max(2000),
});

export const updateShortcutSchema = createShortcutSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'Nothing to update',
);

export type CreateShortcutInput = z.infer<typeof createShortcutSchema>;
export type UpdateShortcutInput = z.infer<typeof updateShortcutSchema>;

/**
 * The placeholders a shortcut body may contain.
 *
 * Deliberately tiny and resolved from data the composer already holds. Anything unresolved is left
 * as written rather than blanked, so an agent sees the mistake before they send it.
 */
export const SHORTCUT_PLACEHOLDERS = [
  '{{visitor.name}}',
  '{{visitor.email}}',
  '{{agent.name}}',
  '{{account.name}}',
] as const;

export function expandShortcut(body: string, values: Record<string, string | null>): string {
  return body.replace(/\{\{\s*([a-z]+\.[a-z]+)\s*\}\}/gi, (whole, path: string) => {
    const value = values[path.toLowerCase()];
    return value && value.trim().length > 0 ? value : whole;
  });
}
