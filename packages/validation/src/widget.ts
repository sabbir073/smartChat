import { z } from 'zod';
import { hexColorSchema, localeSchema } from './common.js';

/**
 * The widget configuration contract.
 *
 * This schema is the single source of truth for what a widget can be configured to do. It is used
 * by the builder to validate edits, by the API to validate writes, and by the widget itself to
 * parse what it receives - so preview and production cannot drift apart.
 *
 * Every field has a default. That is what makes the config additive: an older cached loader that
 * has never heard of a new field simply gets the default, and adding a setting never requires a
 * database migration or a coordinated deploy.
 */

export const widgetPositionSchema = z.enum([
  'bottom_right',
  'bottom_left',
  'top_right',
  'top_left',
]);

export const widgetThemeSchema = z.enum(['light', 'dark', 'auto']);

export const formFieldSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, numbers and underscores'),
  label: z.string().trim().min(1).max(60),
  type: z.enum(['text', 'email', 'phone', 'textarea', 'select', 'checkbox']),
  requirement: z.enum(['required', 'optional', 'disabled']).default('optional'),
  placeholder: z.string().trim().max(80).optional(),
  options: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
});

export type FormField = z.infer<typeof formFieldSchema>;

export const appearanceSchema = z.object({
  primaryColor: hexColorSchema.default('#2F6FED'),
  headerColor: hexColorSchema.default('#2F6FED'),
  headerTextColor: hexColorSchema.default('#FFFFFF'),
  launcherColor: hexColorSchema.default('#2F6FED'),
  launcherIconColor: hexColorSchema.default('#FFFFFF'),
  theme: widgetThemeSchema.default('light'),
  borderRadius: z.number().int().min(0).max(32).default(16),
  fontFamily: z.enum(['system', 'inter', 'georgia', 'mono']).default('system'),
  launcherSize: z.number().int().min(44).max(80).default(60),
  avatarUrl: z.string().url().max(2048).nullable().default(null),
  logoUrl: z.string().url().max(2048).nullable().default(null),
});

export const placementSchema = z.object({
  position: widgetPositionSchema.default('bottom_right'),
  offsetX: z.number().int().min(0).max(200).default(20),
  offsetY: z.number().int().min(0).max(200).default(20),
  showOnDesktop: z.boolean().default(true),
  showOnMobile: z.boolean().default(true),
  /** Where the widget may appear. Empty means everywhere. */
  hideOnUrls: z.array(z.string().trim().max(300)).max(50).default([]),
});

export const behaviourSchema = z.object({
  startOpen: z.boolean().default(false),
  showDelaySeconds: z.number().int().min(0).max(600).default(0),
  soundEnabled: z.boolean().default(true),
  showUnreadBadge: z.boolean().default(true),
  showTypingIndicator: z.boolean().default(true),
  showAgentTyping: z.boolean().default(true),
  /** Ask for details before the first message. */
  preChatEnabled: z.boolean().default(true),
  /** Collect a message when nobody is available. */
  offlineFormEnabled: z.boolean().default(true),
  /** Whether the visitor can request a transcript. Implemented in Phase 9. */
  requireConsent: z.boolean().default(false),
});

export const contentSchema = z.object({
  businessName: z.string().trim().min(1).max(60).default('Support'),
  title: z.string().trim().min(1).max(60).default('Chat with us'),
  subtitleOnline: z.string().trim().max(80).default('We typically reply in a few minutes'),
  subtitleOffline: z.string().trim().max(80).default('Leave a message and we will get back to you'),
  welcomeMessage: z.string().trim().max(500).default('Hello. How can we help you today?'),
  inputPlaceholder: z.string().trim().max(60).default('Type your message'),
  offlineMessage: z
    .string()
    .trim()
    .max(500)
    .default('We are offline right now. Leave us a message and we will reply by email.'),
  agentDisplayName: z.string().trim().max(60).default('Support'),
  consentText: z
    .string()
    .trim()
    .max(300)
    .default('By starting a chat you agree to our privacy policy.'),
  locale: localeSchema.default('en'),
});

export const formsSchema = z.object({
  preChatIntro: z.string().trim().max(200).default('Tell us how to reach you.'),
  preChatFields: z
    .array(formFieldSchema)
    .max(12)
    .default([
      { key: 'name', label: 'Your name', type: 'text', requirement: 'required' },
      { key: 'email', label: 'Email', type: 'email', requirement: 'required' },
    ]),
  offlineIntro: z.string().trim().max(200).default('We will reply by email.'),
  offlineFields: z
    .array(formFieldSchema)
    .max(12)
    .default([
      { key: 'name', label: 'Your name', type: 'text', requirement: 'required' },
      { key: 'email', label: 'Email', type: 'email', requirement: 'required' },
      { key: 'message', label: 'How can we help?', type: 'textarea', requirement: 'required' },
    ]),
});

export const widgetConfigSchema = z.object({
  appearance: appearanceSchema.default({}),
  placement: placementSchema.default({}),
  behaviour: behaviourSchema.default({}),
  content: contentSchema.default({}),
  forms: formsSchema.default({}),
});

export type WidgetConfig = z.infer<typeof widgetConfigSchema>;
export type WidgetAppearance = z.infer<typeof appearanceSchema>;
export type WidgetPlacement = z.infer<typeof placementSchema>;
export type WidgetBehaviour = z.infer<typeof behaviourSchema>;
export type WidgetContent = z.infer<typeof contentSchema>;
export type WidgetForms = z.infer<typeof formsSchema>;

/** The configuration a brand-new property starts with. */
export const DEFAULT_WIDGET_CONFIG: WidgetConfig = widgetConfigSchema.parse({});

/**
 * Parse a stored configuration, filling in anything missing.
 *
 * A config written by an older release is upgraded on read rather than rejected, which is what
 * lets the schema evolve without a backfill.
 */
export function parseWidgetConfig(value: unknown): WidgetConfig {
  const result = widgetConfigSchema.safeParse(value ?? {});
  return result.success ? result.data : DEFAULT_WIDGET_CONFIG;
}

/** Partial update from the builder. Every section is optional, every field within it too. */
export const updateWidgetConfigSchema = z.object({
  appearance: appearanceSchema.partial().optional(),
  placement: placementSchema.partial().optional(),
  behaviour: behaviourSchema.partial().optional(),
  content: contentSchema.partial().optional(),
  forms: formsSchema.partial().optional(),
});

export type UpdateWidgetConfigInput = z.infer<typeof updateWidgetConfigSchema>;

// ---------------------------------------------------------------------------
// Submitted form values
// ---------------------------------------------------------------------------

export interface CollectedForm {
  /** Only the keys the property actually configured, trimmed and length-capped. */
  values: Record<string, string>;
  /** Labels of required fields that arrived empty. */
  missing: string[];
  /** Labels of fields whose value is the wrong shape - an email that is not one. */
  invalid: string[];
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reduce whatever a visitor submitted to what the property asked for.
 *
 * The widget renders the configured fields, but the widget is on somebody else's website and the
 * request can be replayed by hand - so the field list is applied again here, on the server. Keys
 * that were never configured are dropped rather than rejected: the goal is to store the answers
 * the customer asked for, not to argue with a page we do not control.
 */
export function collectFormValues(
  fields: readonly FormField[],
  submitted: Record<string, unknown>,
): CollectedForm {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  const invalid: string[] = [];

  for (const field of fields) {
    if (field.requirement === 'disabled') continue;

    const raw = submitted[field.key];
    const value = typeof raw === 'string' ? raw.trim().slice(0, 2000) : '';

    if (value.length === 0) {
      if (field.requirement === 'required') missing.push(field.label);
      continue;
    }
    if (field.type === 'email' && !EMAIL_SHAPE.test(value)) {
      invalid.push(field.label);
      continue;
    }
    if (field.type === 'select' && field.options && !field.options.includes(value)) {
      invalid.push(field.label);
      continue;
    }
    values[field.key] = value;
  }

  return { values, missing, invalid };
}

/** The visitor traits a form's answers imply. Everything else stays on the conversation. */
export function traitsFromForm(values: Record<string, string>): {
  name?: string;
  email?: string;
  phone?: string;
} {
  return {
    ...(values['name'] ? { name: values['name'] } : {}),
    ...(values['email'] ? { email: values['email'] } : {}),
    ...(values['phone'] ? { phone: values['phone'] } : {}),
  };
}

/** The message body an offline submission carries, whatever the customer named the field. */
export function offlineMessageBody(
  fields: readonly FormField[],
  values: Record<string, string>,
): string | null {
  const textarea = fields.find(
    (field) => field.type === 'textarea' && field.requirement !== 'disabled',
  );
  const key = textarea?.key ?? 'message';
  const body = values[key];
  return body && body.length > 0 ? body : null;
}
