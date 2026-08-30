import { z } from 'zod';
import { emailSchema, paginationSchema, uuidSchema } from './common.js';

/**
 * Contacts and the fields an account decides to keep about people.
 *
 * Custom fields are configuration, not code: an account defines what it wants to record, and the
 * values are validated against those definitions on every write. A value for a field that does not
 * exist is dropped rather than stored, so the contact record cannot become a place to park
 * arbitrary data.
 */

export const contactFieldTypeSchema = z.enum([
  'text',
  'number',
  'url',
  'date',
  'select',
  'boolean',
]);

export type ContactFieldTypeName = z.infer<typeof contactFieldTypeSchema>;

export const contactFieldKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'Use lowercase letters, numbers and underscores');

export const createContactFieldSchema = z
  .object({
    key: contactFieldKeySchema,
    label: z.string().trim().min(1).max(60),
    type: contactFieldTypeSchema.default('text'),
    options: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
    position: z.number().int().min(0).max(999).default(0),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'select' && value.options.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'A list field needs at least one option to choose from',
      });
    }
    if (value.type !== 'select' && value.options.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Only a list field has options',
      });
    }
  });

export const updateContactFieldSchema = z
  .object({
    label: z.string().trim().min(1).max(60).optional(),
    options: z.array(z.string().trim().min(1).max(60)).max(40).optional(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export type CreateContactFieldInput = z.infer<typeof createContactFieldSchema>;
export type UpdateContactFieldInput = z.infer<typeof updateContactFieldSchema>;

export const updateContactSchema = z
  .object({
    name: z.string().trim().max(120).nullable().optional(),
    email: emailSchema.nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    company: z.string().trim().max(120).nullable().optional(),
    notes: z.string().trim().max(5000).nullable().optional(),
    /** Keys are matched against the account's definitions; anything else is dropped. */
    customFields: z.record(z.string().max(40), z.string().max(500)).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export type UpdateContactInput = z.infer<typeof updateContactSchema>;

export const listContactsSchema = paginationSchema.extend({
  search: z.string().trim().min(1).max(120).optional(),
});

export type ListContactsInput = z.infer<typeof listContactsSchema>;

export const contactIdSchema = z.object({ id: uuidSchema });

export interface ContactFieldDefinitionLike {
  key: string;
  label: string;
  type: ContactFieldTypeName;
  options: string[];
}

export interface CollectedCustomFields {
  values: Record<string, string>;
  invalid: string[];
}

/**
 * Reduce submitted custom-field values to what the account actually defined.
 *
 * A value whose field does not exist is dropped silently: the definitions can change while
 * somebody has a contact page open, and refusing the whole save because one field was deleted
 * underneath them would lose the rest of their edit. A value whose *shape* is wrong is reported,
 * because that is the person's mistake and they can fix it.
 */
export function collectCustomFields(
  definitions: readonly ContactFieldDefinitionLike[],
  submitted: Record<string, unknown>,
): CollectedCustomFields {
  const values: Record<string, string> = {};
  const invalid: string[] = [];

  for (const definition of definitions) {
    const raw = submitted[definition.key];
    if (raw === undefined) continue;
    const value = typeof raw === 'string' ? raw.trim().slice(0, 500) : '';

    // An empty value means "clear this", which is always allowed.
    if (value.length === 0) continue;

    switch (definition.type) {
      case 'number':
        if (!Number.isFinite(Number(value))) invalid.push(definition.label);
        else values[definition.key] = value;
        break;
      case 'url':
        if (!/^https?:\/\/[^\s]+$/i.test(value)) invalid.push(definition.label);
        else values[definition.key] = value;
        break;
      case 'date':
        if (Number.isNaN(Date.parse(value))) invalid.push(definition.label);
        else values[definition.key] = value;
        break;
      case 'select':
        if (!definition.options.includes(value)) invalid.push(definition.label);
        else values[definition.key] = value;
        break;
      case 'boolean':
        if (value !== 'true' && value !== 'false') invalid.push(definition.label);
        else values[definition.key] = value;
        break;
      default:
        values[definition.key] = value;
    }
  }

  return { values, invalid };
}
